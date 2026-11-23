import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp } from 'ink';
import { Spinner, StatusMessage } from '@inkjs/ui';
import { Command } from 'commander';
import { App } from '../../components/App.js';
import { DataTable } from '../../components/DataTable.js';
import { InteractiveList } from '../../components/InteractiveList.js';
import { createSdkClient } from '../../lib/sdk-client.js';
import { getWorkspaceId, getProjectId, setWorkspaceId, setProjectId, requireAuth } from '../../lib/config.js';
import { renderCommand, jsonError, stdoutWrite } from '../../lib/render.js';
import { isNonInteractive, isJsonMode } from '../../lib/cli-flags.js';
import { formatSelectLabel } from '../../lib/format-option-label.js';
import type { WorkspaceWithProjects, Project } from '../../lib/types.js';
import { fetchWorkspacesWithProjects } from '../../lib/workspaces.js';
import { errorMessage } from '../../lib/errors.js';

type Step = 'loading' | 'selectWorkspace' | 'selectProject' | 'done' | 'cancelled' | 'error';

interface ListWorkspacesCommandProps {
  json?: boolean;
}

function ListWorkspacesCommand({ json: jsonProp }: ListWorkspacesCommandProps): React.ReactElement {
  const json = jsonProp || isJsonMode();
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('loading');
  const [workspaces, setWorkspaces] = useState<WorkspaceWithProjects[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<WorkspaceWithProjects | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentWorkspaceId = getWorkspaceId();
  const currentProjectId = getProjectId();

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

        if (json || isNonInteractive()) {
          setStep('done');
        } else {
          setStep('selectWorkspace');
        }
      })
      .catch((err) => {
        setError(errorMessage(err, 'Failed to list workspaces'));
        setStep('error');
      });
  }, []);

  // --- Transition: after workspace selection, chain into project picker ---
  const transitionToProjectStep = useCallback(
    (ws: WorkspaceWithProjects) => {
      const projects = ws.projects || [];
      if (projects.length === 0) {
        // No projects — just finish with workspace switch
        setStep('done');
      } else if (projects.length === 1) {
        // Auto-select the only project
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

  // JSON output
  useEffect(() => {
    if (step === 'done' && json && !error) {
      stdoutWrite(JSON.stringify(workspaces, null, 2));
      exit();
    }
  }, [step, json, workspaces, exit]);

  // Non-interactive static table auto-exit
  useEffect(() => {
    if (step === 'done' && !json && isNonInteractive() && !error) {
      const timer = setTimeout(() => exit(), 100);
      return () => clearTimeout(timer);
    }
    return;
  }, [step, json, error, exit]);

  // Exit on cancel
  useEffect(() => {
    if (step === 'cancelled') {
      const timer = setTimeout(() => exit(), 100);
      return () => clearTimeout(timer);
    }
    return;
  }, [step, exit]);

  // Error exit
  useEffect(() => {
    if (step === 'error' && error) {
      jsonError(error);
      const timer = setTimeout(() => exit(new Error(error)), 100);
      return () => clearTimeout(timer);
    }
    return;
  }, [step, error, exit]);

  // Done (interactive) exit
  useEffect(() => {
    if (step === 'done' && selectedWorkspace && !json && !isNonInteractive()) {
      const timer = setTimeout(() => exit(), 100);
      return () => clearTimeout(timer);
    }
    return;
  }, [step, selectedWorkspace, json, exit]);

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

  // --- Loading ---
  if (step === 'loading') {
    return (
      <App>
        <Spinner label="Fetching workspaces..." />
      </App>
    );
  }

  // --- Error ---
  if (step === 'error') {
    return (
      <App>
        <StatusMessage variant="error">{error}</StatusMessage>
      </App>
    );
  }

  // --- JSON: handled by effect ---
  if (json) return <></>;

  // --- Cancelled ---
  if (step === 'cancelled') {
    return (
      <App>
        <Text dimColor>  Cancelled</Text>
      </App>
    );
  }

  // --- Non-interactive static table ---
  if (isNonInteractive()) {
    if (workspaces.length === 0) {
      return (
        <App>
          <StatusMessage variant="info">No workspaces found</StatusMessage>
        </App>
      );
    }

    const tableData = workspaces.map((ws) => ({
      ' ': ws.id === currentWorkspaceId ? '\u25CF' : ' ',
      ID: ws.id,
      Name: ws.name,
    }));

    return (
      <App>
        <Box flexDirection="column" gap={1}>
          <Text bold> Your Workspaces</Text>
          <DataTable data={tableData} columns={[' ', 'ID', 'Name']} />
          <Text>
            {'  '}
            <Text color="green">{'\u25CF'}</Text>
            <Text dimColor> = current workspace</Text>
          </Text>
        </Box>
      </App>
    );
  }

  // --- Interactive: select workspace ---
  if (step === 'selectWorkspace') {
    const maxNameLen = Math.max(...workspaces.map((ws) => (ws.name || 'Unnamed').length));

    const items = workspaces.map((ws) => ({
      label: formatSelectLabel([
        { text: ws.name || 'Unnamed', width: maxNameLen },
        { text: `ID: ${ws.id}`, width: 12 },
      ]),
      value: String(ws.id),
      isCurrent: ws.id === currentWorkspaceId,
    }));

    return (
      <App>
        <InteractiveList
          title="Your Workspaces"
          items={items}
          onSelect={handleWorkspaceSelect}
          onCancel={handleCancel}
        />
      </App>
    );
  }

  // --- Interactive: select project ---
  if (step === 'selectProject' && selectedWorkspace) {
    const projects = selectedWorkspace.projects || [];
    const maxNameLen = Math.max(1, ...projects.map((p) => (p.name || 'Unnamed').length));
    const maxStatusLen = Math.max(1, ...projects.map((p) => (p.status || '\u2014').length));

    const items = projects.map((proj) => ({
      label: formatSelectLabel([
        { text: proj.name || 'Unnamed', width: maxNameLen },
        { text: `ID: ${proj.id}`, width: 12 },
        { text: proj.status || '\u2014', width: maxStatusLen },
      ]),
      value: String(proj.id),
      isCurrent: proj.id === currentProjectId,
    }));

    return (
      <App>
        <Box flexDirection="column" gap={1}>
          <Text color="green">
            {'  '}Workspace: <Text bold>{selectedWorkspace.name || String(selectedWorkspace.id)}</Text>
          </Text>
          <InteractiveList
            title="Select a project"
            items={items}
            onSelect={handleProjectSelect}
            onCancel={handleCancel}
          />
        </Box>
      </App>
    );
  }

  // --- Done (interactive selection confirmed) ---
  if (step === 'done' && selectedWorkspace) {
    return (
      <App>
        <Box flexDirection="column">
          <Text color="green">
            {'  '}Switched to workspace <Text bold>{selectedWorkspace.name || String(selectedWorkspace.id)}</Text>
          </Text>
          {selectedProject && (
            <Text color="green">
              {'  '}Switched to project <Text bold>{selectedProject.name || String(selectedProject.id)}</Text>
            </Text>
          )}
        </Box>
      </App>
    );
  }

  return <></>;
}

export const listWorkspacesCommand = new Command('list')
  .description('List all accessible workspaces')
  .option('--json', 'Output as JSON')
  .action((options) => {
    requireAuth();
    const { waitUntilExit } = renderCommand(
      <ListWorkspacesCommand json={options.json} />,
    );
    waitUntilExit().catch((err) => {
      if (err) process.exit(process.exitCode || 1);
    });
  });
