import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp } from 'ink';
import { Spinner, StatusMessage } from '@inkjs/ui';
import { Command } from 'commander';
import { App } from '../../components/App.js';
import { KeyValue } from '../../components/KeyValue.js';
import { InteractiveList } from '../../components/InteractiveList.js';
import { createSdkClient } from '../../lib/sdk-client.js';
import {
  setProjectId,
  setWorkspaceId,
  getWorkspaceId,
  getProjectId,
  requireAuth,
} from '../../lib/config.js';
import { renderCommand, jsonError, stdoutWrite, setUsageError } from '../../lib/render.js';
import { isNonInteractive, isJsonMode } from '../../lib/cli-flags.js';
import { formatSelectLabel } from '../../lib/format-option-label.js';
import type { Project, WorkspaceWithProjects } from '../../lib/types.js';
import { fetchWorkspacesWithProjects } from '../../lib/workspaces.js';
import { errorMessage } from '../../lib/errors.js';

type Step = 'loading' | 'selectWorkspace' | 'selectProject' | 'done' | 'cancelled' | 'error';

interface UseProjectCommandProps {
  projectIdArg?: string;
  json?: boolean;
}

function UseProjectCommand({ projectIdArg, json: jsonProp }: UseProjectCommandProps): React.ReactElement {
  const json = jsonProp || isJsonMode();
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('loading');
  const [workspaces, setWorkspaces] = useState<WorkspaceWithProjects[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<WorkspaceWithProjects | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentWorkspaceId = getWorkspaceId();
  const currentProjectId = getProjectId();

  // Fetch workspaces with projects
  useEffect(() => {
    const client = createSdkClient();
    fetchWorkspacesWithProjects(client)
      .then((detailed) => {
        setWorkspaces(detailed);

        if (detailed.length === 0) {
          setError('No workspaces found');
          setStep('error');
          return;
        }

        if (projectIdArg) {
          const projId = parseInt(projectIdArg, 10);
          if (isNaN(projId)) {
            setError('Invalid project ID. Must be a number.');
            setStep('error');
            return;
          }
          let foundWs: WorkspaceWithProjects | null = null;
          let foundProj: Project | null = null;
          for (const ws of detailed) {
            const proj = ws.projects?.find((p) => p.id === projId);
            if (proj) {
              foundWs = ws;
              foundProj = proj;
              break;
            }
          }
          if (!foundWs || !foundProj) {
            setError(`Project with ID ${projId} not found or not accessible.`);
            setStep('error');
            return;
          }
          setSelectedWorkspace(foundWs);
          setSelectedProject(foundProj);
          if (foundWs.id && foundWs.id !== getWorkspaceId()) {
            setWorkspaceId(foundWs.id);
          }
          setProjectId(projId);
          setStep('done');
        } else {
          const currentWsId = getWorkspaceId();
          if (currentWsId) {
            const ws = detailed.find((w) => w.id === currentWsId);
            if (ws && ws.projects && ws.projects.length > 0) {
              setSelectedWorkspace(ws);
              if (isNonInteractive()) {
                const projs = ws.projects || [];
                setUsageError();
                setError(`Non-interactive mode: provide a project-id argument. Available: ${projs.map((p) => `${p.id} (${p.name})`).join(', ')}`);
                setStep('error');
              } else {
                setStep('selectProject');
              }
            } else if (ws) {
              setError('No projects found in the current workspace.');
              setStep('error');
            } else {
              if (isNonInteractive()) {
                setUsageError();
                setError('Non-interactive mode: set a workspace first with unlayer workspace use <id>.');
                setStep('error');
              } else {
                setStep('selectWorkspace');
              }
            }
          } else {
            if (isNonInteractive()) {
              setUsageError();
              setError('Non-interactive mode: set a workspace first with unlayer workspace use <id>.');
              setStep('error');
            } else {
              setStep('selectWorkspace');
            }
          }
        }
      })
      .catch((err) => {
        setError(errorMessage(err, 'Failed to fetch projects'));
        setStep('error');
      });
  }, [projectIdArg]);

  const handleWorkspaceSelect = useCallback(
    (value: string) => {
      const wsId = parseInt(value, 10);
      const ws = workspaces.find((w) => w.id === wsId);
      if (ws) {
        setSelectedWorkspace(ws);
        setWorkspaceId(wsId);
        if (!ws.projects || ws.projects.length === 0) {
          setError('No projects found in the selected workspace.');
          setStep('error');
          return;
        }
        setStep('selectProject');
      }
    },
    [workspaces],
  );

  const handleProjectSelect = useCallback(
    (value: string) => {
      const projId = parseInt(value, 10);
      const proj = selectedWorkspace?.projects?.find((p) => p.id === projId);
      if (proj) {
        setSelectedProject(proj);
        setProjectId(projId);
        setStep('done');
      }
    },
    [selectedWorkspace],
  );

  const handleCancel = useCallback(() => {
    setStep('cancelled');
  }, []);

  // JSON output on success
  useEffect(() => {
    if (step === 'done' && json && selectedWorkspace && selectedProject) {
      stdoutWrite(JSON.stringify({
        workspace: { id: selectedWorkspace.id, name: selectedWorkspace.name },
        project: { id: selectedProject.id, name: selectedProject.name },
      }, null, 2));
    }
  }, [step, json, selectedWorkspace, selectedProject]);

  useEffect(() => {
    if (step === 'done') {
      const timer = setTimeout(() => exit(), 100);
      return () => clearTimeout(timer);
    }
    if (step === 'cancelled') {
      const timer = setTimeout(() => exit(), 100);
      return () => clearTimeout(timer);
    }
    if (step === 'error' && error) {
      jsonError(error);
      const timer = setTimeout(() => exit(new Error(error)), 100);
      return () => clearTimeout(timer);
    }
    return;
  }, [step, exit, error]);

  // Build workspace interactive items
  const workspaceItems = (() => {
    const maxNameLen = Math.max(1, ...workspaces.map((ws) => (ws.name || 'Unnamed').length));
    return workspaces.map((ws) => ({
      label: formatSelectLabel([
        { text: ws.name || 'Unnamed', width: maxNameLen },
        { text: `ID: ${ws.id}`, width: 12 },
      ]),
      value: String(ws.id),
      isCurrent: ws.id === currentWorkspaceId,
    }));
  })();

  // Build project interactive items
  const projectItems = (() => {
    const projects = selectedWorkspace?.projects || [];
    const maxNameLen = Math.max(1, ...projects.map((p) => (p.name || 'Unnamed').length));
    const maxStatusLen = Math.max(1, ...projects.map((p) => (p.status || '\u2014').length));
    return projects.map((proj) => ({
      label: formatSelectLabel([
        { text: proj.name || 'Unnamed', width: maxNameLen },
        { text: `ID: ${proj.id}`, width: 12 },
        { text: proj.status || '\u2014', width: maxStatusLen },
      ]),
      value: String(proj.id),
      isCurrent: proj.id === currentProjectId,
    }));
  })();

  return (
    <App>
      {step === 'loading' && <Spinner label="Fetching projects..." />}

      {step === 'selectWorkspace' && !isNonInteractive() && (
        <Box flexDirection="column" gap={1}>
          <StatusMessage variant="info">
            No workspace selected. Please select a workspace first.
          </StatusMessage>
          <InteractiveList
            title="Select a workspace"
            items={workspaceItems}
            onSelect={handleWorkspaceSelect}
            onCancel={handleCancel}
          />
        </Box>
      )}

      {step === 'selectProject' && !isNonInteractive() && selectedWorkspace && (
        <InteractiveList
          title="Select a project"
          items={projectItems}
          onSelect={handleProjectSelect}
          onCancel={handleCancel}
        />
      )}

      {step === 'cancelled' && (
        <Text dimColor>  Cancelled</Text>
      )}

      {step === 'done' && selectedWorkspace && selectedProject && (
        <Box flexDirection="column" gap={1}>
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={2}
          >
            <Text bold>Context Updated</Text>
            <KeyValue
              pairs={[
                { key: 'Workspace', value: selectedWorkspace.name },
                { key: 'Project', value: selectedProject.name },
              ]}
              indent={0}
            />
          </Box>
          <Text color="green">
            {'  '}Switched to{' '}
            <Text bold>
              {selectedProject.name || String(selectedProject.id)}
            </Text>
          </Text>
        </Box>
      )}

      {step === 'error' && error && (
        <StatusMessage variant="error">{error}</StatusMessage>
      )}
    </App>
  );
}

export const useProjectCommand = new Command('use')
  .description('Set the active project')
  .argument('[project-id]', 'Project ID to use')
  .option('--json', 'Output as JSON')
  .action((projectIdArg, options) => {
    requireAuth();
    const { waitUntilExit } = renderCommand(
      <UseProjectCommand projectIdArg={projectIdArg} json={options.json} />,
    );
    waitUntilExit().catch((err) => {
      if (err) process.exit(process.exitCode || 1);
    });
  });
