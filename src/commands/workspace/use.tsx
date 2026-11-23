import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp } from 'ink';
import { Spinner, StatusMessage } from '@inkjs/ui';
import { Command } from 'commander';
import { App } from '../../components/App.js';
import { KeyValue } from '../../components/KeyValue.js';
import { InteractiveList } from '../../components/InteractiveList.js';
import { createSdkClient } from '../../lib/sdk-client.js';
import { getWorkspaceId, getProjectId, setWorkspaceId, setProjectId, requireAuth } from '../../lib/config.js';
import { renderCommand, jsonError, stdoutWrite, setUsageError } from '../../lib/render.js';
import { isNonInteractive, isJsonMode } from '../../lib/cli-flags.js';
import { formatSelectLabel } from '../../lib/format-option-label.js';
import type { Project, WorkspaceWithProjects } from '../../lib/types.js';
import { fetchWorkspacesWithProjects } from '../../lib/workspaces.js';
import { errorMessage } from '../../lib/errors.js';

type Step = 'loading' | 'selectWorkspace' | 'selectProject' | 'done' | 'cancelled' | 'error';

interface UseWorkspaceCommandProps {
  workspaceIdArg?: string;
  json?: boolean;
}

function UseWorkspaceCommand({ workspaceIdArg, json: jsonProp }: UseWorkspaceCommandProps): React.ReactElement {
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
      .then((wsList) => {
        setWorkspaces(wsList);

        if (wsList.length === 0) {
          setError('No workspaces found');
          setStep('error');
          return;
        }

        if (workspaceIdArg) {
          // Direct switch by ID — unchanged behavior (no project chaining)
          const wsId = parseInt(workspaceIdArg, 10);
          if (isNaN(wsId)) {
            setError('Invalid workspace ID. Must be a number.');
            setStep('error');
            return;
          }
          const ws = wsList.find((w) => w.id === wsId);
          if (!ws) {
            setError(`Workspace with ID ${wsId} not found or not accessible.`);
            setStep('error');
            return;
          }
          setSelectedWorkspace(ws);
          setProjectId(null);
          setWorkspaceId(wsId);
          setStep('done');
        } else if (isNonInteractive()) {
          setUsageError();
          setError(`Non-interactive mode: provide a workspace-id argument. Available: ${wsList.map((w) => `${w.id} (${w.name})`).join(', ')}`);
          setStep('error');
        } else {
          setStep('selectWorkspace');
        }
      })
      .catch((err) => {
        setError(errorMessage(err, 'Failed to fetch workspaces'));
        setStep('error');
      });
  }, [workspaceIdArg]);

  // --- Transition: after workspace selection, chain into project picker ---
  const transitionToProjectStep = useCallback(
    (ws: WorkspaceWithProjects) => {
      const projects = ws.projects || [];
      if (projects.length === 0) {
        setStep('done');
      } else if (projects.length === 1) {
        const proj = projects[0];
        setSelectedProject(proj);
        setProjectId(proj.id!);
        setStep('done');
      } else {
        setStep('selectProject');
      }
    },
    [],
  );

  const handleWorkspaceSelect = useCallback(
    (value: string) => {
      const wsId = parseInt(value, 10);
      const ws = workspaces.find((w) => w.id === wsId);
      if (ws) {
        setSelectedWorkspace(ws);
        setWorkspaceId(wsId);
        setProjectId(null);
        transitionToProjectStep(ws);
      }
    },
    [workspaces, transitionToProjectStep],
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
    if (step === 'done' && json && selectedWorkspace) {
      const output: Record<string, unknown> = {
        workspace: { id: selectedWorkspace.id, name: selectedWorkspace.name },
      };
      if (selectedProject) {
        output.project = { id: selectedProject.id, name: selectedProject.name };
      }
      stdoutWrite(JSON.stringify(output, null, 2));
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

  // Build workspace items
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

  // Build project items
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
      {step === 'loading' && (
        <Spinner label="Fetching workspaces..." />
      )}

      {step === 'selectWorkspace' && !isNonInteractive() && (
        <InteractiveList
          title="Select a workspace"
          items={workspaceItems}
          onSelect={handleWorkspaceSelect}
          onCancel={handleCancel}
        />
      )}

      {step === 'selectProject' && !isNonInteractive() && selectedWorkspace && (
        <Box flexDirection="column" gap={1}>
          <Text color="green">
            {'  '}Workspace: <Text bold>{selectedWorkspace.name || String(selectedWorkspace.id)}</Text>
          </Text>
          <InteractiveList
            title="Select a project"
            items={projectItems}
            onSelect={handleProjectSelect}
            onCancel={handleCancel}
          />
        </Box>
      )}

      {step === 'cancelled' && (
        <Text dimColor>  Cancelled</Text>
      )}

      {step === 'done' && selectedWorkspace && (
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
                ...(selectedProject
                  ? [{ key: 'Project', value: selectedProject.name }]
                  : []),
              ]}
              indent={0}
            />
          </Box>
          <Text color="green">
            {'  '}Switched to <Text bold>{selectedWorkspace.name || String(selectedWorkspace.id)}</Text>
            {selectedProject && (
              <Text> / <Text bold>{selectedProject.name || String(selectedProject.id)}</Text></Text>
            )}
          </Text>
          {!selectedProject && (
            <Box flexDirection="column" paddingX={2}>
              <Text dimColor>
                Run <Text color="cyan">unlayer project use</Text> to select a project.
              </Text>
            </Box>
          )}
        </Box>
      )}

      {step === 'error' && error && (
        <StatusMessage variant="error">{error}</StatusMessage>
      )}
    </App>
  );
}

export const useWorkspaceCommand = new Command('use')
  .description('Set the active workspace')
  .argument('[workspace-id]', 'Workspace ID to use')
  .option('--json', 'Output as JSON')
  .action((workspaceIdArg, options) => {
    requireAuth();
    const { waitUntilExit } = renderCommand(
      <UseWorkspaceCommand workspaceIdArg={workspaceIdArg} json={options.json} />,
    );
    waitUntilExit().catch((err) => {
      if (err) process.exit(process.exitCode || 1);
    });
  });
