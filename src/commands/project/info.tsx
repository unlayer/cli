import React, { useState, useEffect } from 'react';
import { Box, Text, useApp } from 'ink';
import { Spinner, StatusMessage } from '@inkjs/ui';
import { Command } from 'commander';
import { App } from '../../components/App.js';
import { KeyValue } from '../../components/KeyValue.js';
import { DataTable } from '../../components/DataTable.js';
import { createSdkClient } from '../../lib/sdk-client.js';
import { getProjectId, requireAuth } from '../../lib/config.js';
import { renderCommand, jsonError, stdoutWrite } from '../../lib/render.js';
import { isJsonMode } from '../../lib/cli-flags.js';
import { errorMessage } from '../../lib/errors.js';

interface ProjectData {
  id?: number | string;
  name?: string;
  status?: string;
  createdAt?: string;
  workspace?: { id?: number; name?: string };
  [key: string]: unknown;
}

interface TemplateItem {
  id?: string;
  name?: string;
  displayMode?: string;
}

interface InfoProjectCommandProps {
  projectIdArg?: string;
  json?: boolean;
}

function InfoProjectCommand({
  projectIdArg,
  json: jsonProp,
}: InfoProjectCommandProps): React.ReactElement {
  const json = jsonProp || isJsonMode();
  const { exit } = useApp();
  const [loading, setLoading] = useState(true);
  const [projectData, setProjectData] = useState<ProjectData | null>(null);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const projectId = projectIdArg ? parseInt(projectIdArg, 10) : getProjectId();

  useEffect(() => {
    if (!projectId) {
      setError(
        'No project specified. Provide a project ID or use `unlayer project use` to set a default.',
      );
      setLoading(false);
      return;
    }

    const client = createSdkClient();
    Promise.all([
      client.projects.retrieve(String(projectId)),
      client.templates
        .list({ projectId: String(projectId) })
        .catch(() => null),
    ])
      .then(([projectRes, templatesPage]) => {
        setProjectData(projectRes.data as ProjectData);
        const items: TemplateItem[] = [];
        if (templatesPage) {
          for (const item of templatesPage.data || []) {
            items.push(item as TemplateItem);
          }
        }
        setTemplates(items);
        setLoading(false);
      })
      .catch((err) => {
        setError(errorMessage(err, 'Failed to get project info'));
        setLoading(false);
      });
  }, [projectId]);

  useEffect(() => {
    if (!loading && json && !error && projectData) {
      stdoutWrite(
        JSON.stringify(
          {
            project: projectData,
            workspace: projectData.workspace,
            templates: templates.map((t) => ({
              id: t.id,
              name: t.name,
              displayMode: t.displayMode,
            })),
          },
          null,
          2,
        ),
      );
      exit();
    }
  }, [loading, json, projectData, templates, exit]);

  useEffect(() => {
    if (!loading && !json && !error) {
      const timer = setTimeout(() => exit(), 100);
      return () => clearTimeout(timer);
    }
    if (!loading && error) {
      jsonError(error);
      const timer = setTimeout(() => exit(new Error(error)), 100);
      return () => clearTimeout(timer);
    }
    return;
  }, [loading, json, error, exit]);

  if (loading) {
    return (
      <App>
        <Spinner label="Fetching project information..." />
      </App>
    );
  }

  if (error) {
    return (
      <App>
        <StatusMessage variant="error">{error}</StatusMessage>
      </App>
    );
  }

  if (json || !projectData) return <></>;

  return (
    <App>
      <Box flexDirection="column" gap={1}>
        {/* Project details */}
        <Box flexDirection="column">
          <Text bold>{` Project: ${projectData.name}`}</Text>
          <KeyValue
            pairs={[
              { key: 'ID', value: projectData.id },
              { key: 'Status', value: projectData.status },
              {
                key: 'Workspace',
                value: projectData.workspace
                  ? `${projectData.workspace.name} (ID: ${projectData.workspace.id})`
                  : null,
              },
              {
                key: 'Created',
                value: projectData.createdAt
                  ? new Date(projectData.createdAt).toLocaleDateString()
                  : null,
              },
            ]}
          />
        </Box>

        {/* Templates */}
        <Box flexDirection="column">
          <Text bold>{' Templates'}</Text>
          {templates.length === 0 ? (
            <Text dimColor>  No templates found</Text>
          ) : (
            <DataTable
              data={templates.map((t) => ({
                ID: t.id,
                Name: t.name,
                'Display Mode': t.displayMode || '\u2014',
              }))}
              columns={['ID', 'Name', 'Display Mode']}
            />
          )}
        </Box>

        <Text color="green">  Project info loaded</Text>
      </Box>
    </App>
  );
}

export const infoProjectCommand = new Command('info')
  .description('Get detailed information about a project')
  .argument('[project-id]', 'Project ID (defaults to current project)')
  .option('--project-id <id>', 'Project ID (flag alias for the positional argument)')
  .option('--json', 'Output as JSON')
  .action((projectIdArg, options) => {
    requireAuth();
    const { waitUntilExit } = renderCommand(
      <InfoProjectCommand
        projectIdArg={projectIdArg || options.projectId}
        json={options.json}
      />,
    );
    waitUntilExit().catch((err) => {
      if (err) process.exit(process.exitCode || 1);
    });
  });
