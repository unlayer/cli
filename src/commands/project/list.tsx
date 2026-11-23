import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp } from 'ink';
import { Spinner, StatusMessage } from '@inkjs/ui';
import { Command } from 'commander';
import { App } from '../../components/App.js';
import { DataTable } from '../../components/DataTable.js';
import { InteractiveList } from '../../components/InteractiveList.js';
import { createSdkClient } from '../../lib/sdk-client.js';
import { getProjectId, setWorkspaceId, setProjectId, requireAuth } from '../../lib/config.js';
import { renderCommand, jsonError, stdoutWrite } from '../../lib/render.js';
import { isNonInteractive, isJsonMode } from '../../lib/cli-flags.js';
import { formatSelectLabel } from '../../lib/format-option-label.js';
import type { WorkspaceWithProjects, Project } from '../../lib/types.js';
import { fetchWorkspacesWithProjects } from '../../lib/workspaces.js';
import { errorMessage } from '../../lib/errors.js';

type Step = 'loading' | 'select' | 'done' | 'cancelled' | 'error';

interface FlatProject {
  project: Project;
  workspaceId: number;
  workspaceName: string;
}

interface ListProjectsCommandProps {
  workspace?: string;
  json?: boolean;
}

function ListProjectsCommand({
  workspace: workspaceFilter,
  json: jsonProp,
}: ListProjectsCommandProps): React.ReactElement {
  const json = jsonProp || isJsonMode();
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('loading');
  const [workspacesWithProjects, setWorkspacesWithProjects] = useState<WorkspaceWithProjects[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<FlatProject | null>(null);

  const currentProjectId = getProjectId();

  const wsFilterId = workspaceFilter
    ? parseInt(workspaceFilter, 10)
    : undefined;

  useEffect(() => {
    const client = createSdkClient();
    fetchWorkspacesWithProjects(client)
      .then((detailed) => {
        setWorkspacesWithProjects(detailed);

        if (detailed.length === 0) {
          setError('No workspaces found');
          setStep('error');
          return;
        }

        if (json || isNonInteractive()) {
          setStep('done');
        } else {
          setStep('select');
        }
      })
      .catch((err) => {
        setError(errorMessage(err, 'Failed to list projects'));
        setStep('error');
      });
  }, []);

  // Compute filtered workspaces
  const filteredWorkspaces = wsFilterId
    ? workspacesWithProjects.filter((ws) => ws.id === wsFilterId)
    : workspacesWithProjects;

  // Flatten projects for interactive mode
  const flatProjects: FlatProject[] = filteredWorkspaces.flatMap((ws) =>
    (ws.projects || []).map((proj) => ({
      project: proj,
      workspaceId: ws.id!,
      workspaceName: ws.name || 'Unnamed',
    })),
  );

  // JSON output
  useEffect(() => {
    if (step === 'done' && json && !error) {
      const allProjects = filteredWorkspaces.flatMap((ws) =>
        (ws.projects || []).map((proj) => ({
          ...proj,
          workspaceId: ws.id,
          workspaceName: ws.name,
        })),
      );
      stdoutWrite(JSON.stringify(allProjects, null, 2));
      exit();
    }
  }, [step, json, filteredWorkspaces, exit]);

  // Non-interactive auto-exit
  useEffect(() => {
    if (step === 'done' && !json && isNonInteractive() && !error) {
      const timer = setTimeout(() => exit(), 100);
      return () => clearTimeout(timer);
    }
    return;
  }, [step, json, error, exit]);

  // Cancel exit
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
    if (step === 'done' && selectedProject && !json && !isNonInteractive()) {
      const timer = setTimeout(() => exit(), 100);
      return () => clearTimeout(timer);
    }
    return;
  }, [step, selectedProject, json, exit]);

  const handleSelect = useCallback(
    (value: string) => {
      // Value format: "workspaceId:projectId"
      const [wsIdStr, projIdStr] = value.split(':');
      const wsId = parseInt(wsIdStr, 10);
      const projId = parseInt(projIdStr, 10);

      const flat = flatProjects.find(
        (fp) => fp.workspaceId === wsId && fp.project.id === projId,
      );
      if (flat) {
        setSelectedProject(flat);
        setWorkspaceId(wsId);
        setProjectId(projId);
        setStep('done');
      }
    },
    [flatProjects],
  );

  const handleCancel = useCallback(() => {
    setStep('cancelled');
  }, []);

  // --- Loading ---
  if (step === 'loading') {
    return (
      <App>
        <Spinner label="Fetching projects..." />
      </App>
    );
  }

  // --- Error ---
  if (step === 'error') {
    return (
      <App>
        {wsFilterId && filteredWorkspaces.length === 0 ? (
          <StatusMessage variant="error">
            {`Workspace with ID ${wsFilterId} not found.`}
          </StatusMessage>
        ) : (
          <StatusMessage variant="error">{error}</StatusMessage>
        )}
      </App>
    );
  }

  // --- JSON handled by effect ---
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
    if (filteredWorkspaces.length === 0) {
      return (
        <App>
          {wsFilterId ? (
            <StatusMessage variant="error">
              {`Workspace with ID ${wsFilterId} not found.`}
            </StatusMessage>
          ) : (
            <StatusMessage variant="info">No workspaces found</StatusMessage>
          )}
        </App>
      );
    }

    return (
      <App>
        <Box flexDirection="column" gap={1}>
          {filteredWorkspaces.map((workspace) => (
            <Box key={workspace.id} flexDirection="column" gap={1}>
              <Text bold>
                {' '}
                {workspace.name}{' '}
                <Text dimColor>{`(Workspace #${workspace.id})`}</Text>
              </Text>
              {!workspace.projects || workspace.projects.length === 0 ? (
                <Text dimColor>  No projects in this workspace</Text>
              ) : (
                <DataTable
                  data={workspace.projects.map((proj) => ({
                    ' ': proj.id === currentProjectId ? '\u25CF' : ' ',
                    ID: proj.id,
                    Name: proj.name,
                    Status: proj.status || '\u2014',
                  }))}
                  columns={[' ', 'ID', 'Name', 'Status']}
                />
              )}
            </Box>
          ))}
          <Text>
            {'  '}
            <Text color="green">{'\u25CF'}</Text>
            <Text dimColor> = current project</Text>
          </Text>
        </Box>
      </App>
    );
  }

  // --- Interactive select ---
  if (step === 'select') {
    if (flatProjects.length === 0) {
      return (
        <App>
          <StatusMessage variant="info">No projects found</StatusMessage>
        </App>
      );
    }

    const showWorkspaceColumn = !wsFilterId && filteredWorkspaces.length > 1;

    const maxNameLen = Math.max(...flatProjects.map((fp) => (fp.project.name || 'Unnamed').length));
    const maxStatusLen = Math.max(...flatProjects.map((fp) => (fp.project.status || '\u2014').length));
    const maxWsNameLen = showWorkspaceColumn
      ? Math.max(...flatProjects.map((fp) => fp.workspaceName.length))
      : 0;

    const items = flatProjects.map((fp) => {
      const columns = [
        { text: fp.project.name || 'Unnamed', width: maxNameLen },
        { text: `ID: ${fp.project.id}`, width: 12 },
        { text: fp.project.status || '\u2014', width: maxStatusLen },
      ];

      if (showWorkspaceColumn) {
        columns.push({ text: `(${fp.workspaceName})`, width: maxWsNameLen + 2 });
      }

      return {
        label: formatSelectLabel(columns),
        value: `${fp.workspaceId}:${fp.project.id}`,
        isCurrent: fp.project.id === currentProjectId,
      };
    });

    return (
      <App>
        <InteractiveList
          title="Your Projects"
          items={items}
          onSelect={handleSelect}
          onCancel={handleCancel}
        />
      </App>
    );
  }

  // --- Done (interactive selection confirmed) ---
  if (step === 'done' && selectedProject) {
    return (
      <App>
        <Text color="green">
          {'  '}Switched to project <Text bold>{selectedProject.project.name || String(selectedProject.project.id)}</Text>
          <Text dimColor>{` (${selectedProject.workspaceName})`}</Text>
        </Text>
      </App>
    );
  }

  return <></>;
}

export const listProjectsCommand = new Command('list')
  .description('List all projects in accessible workspaces')
  .option('-w, --workspace <id>', 'Filter by workspace ID')
  .option('--json', 'Output as JSON')
  .action((options) => {
    requireAuth();
    const { waitUntilExit } = renderCommand(
      <ListProjectsCommand workspace={options.workspace} json={options.json} />,
    );
    waitUntilExit().catch((err) => {
      if (err) process.exit(process.exitCode || 1);
    });
  });
