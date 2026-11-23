import React, { useState, useEffect } from 'react';
import { Box, Text, useApp } from 'ink';
import { Spinner, StatusMessage } from '@inkjs/ui';
import { Command } from 'commander';
import { App } from '../../components/App.js';
import { KeyValue } from '../../components/KeyValue.js';
import {
  getToken,
  getApiUrl,
  getWorkspaceId,
  getProjectId,
  getConfigPath,
  requireAuth,
} from '../../lib/config.js';
import { createSdkClient } from '../../lib/sdk-client.js';
import { renderCommand, jsonError, stdoutWrite } from '../../lib/render.js';
import { isJsonMode } from '../../lib/cli-flags.js';
import type { Workspace } from '../../lib/types.js';
import { errorMessage } from '../../lib/errors.js';

interface WhoamiCommandProps {
  json?: boolean;
}

function WhoamiCommand({ json: jsonProp }: WhoamiCommandProps): React.ReactElement {
  const json = jsonProp || isJsonMode();
  const { exit } = useApp();
  const [loading, setLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState<string | null>(null);

  const token = getToken()!;
  const apiUrl = getApiUrl();
  const workspaceId = getWorkspaceId();
  const projectId = getProjectId();

  useEffect(() => {
    const client = createSdkClient();
    client.workspaces
      .list()
      .then((response) => {
        setWorkspaces(response.data || []);
        setLoading(false);
      })
      .catch((err) => {
        setError(errorMessage(err, 'Failed to get account info'));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!loading && json && !error) {
      stdoutWrite(
        JSON.stringify(
          {
            token: {
              prefix: token.substring(0, 20) + '...',
              isEnvVar: !!process.env.UNLAYER_TOKEN,
            },
            apiUrl,
            workspaceId,
            projectId,
            workspaces,
            configPath: getConfigPath(),
          },
          null,
          2,
        ),
      );
      exit();
    }
  }, [loading, json, token, apiUrl, workspaceId, projectId, workspaces, exit]);

  useEffect(() => {
    if (!loading && !json && !error) {
      const timer = setTimeout(() => exit(), 100);
      return () => clearTimeout(timer);
    }
    if (error) {
      jsonError(error);
      const timer = setTimeout(() => exit(new Error(error)), 100);
      return () => clearTimeout(timer);
    }
    return;
  }, [loading, json, error, exit]);

  if (loading) {
    return (
      <App>
        <Spinner label="Fetching account information..." />
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

  if (json) {
    return <></>;
  }

  return (
    <App>
      <Box flexDirection="column" gap={1}>
        {/* Authentication */}
        <Box flexDirection="column">
          <Text bold> Authentication</Text>
          <KeyValue
            pairs={[
              { key: 'Token', value: token.substring(0, 20) + '...' },
              {
                key: 'Source',
                value: process.env.UNLAYER_TOKEN
                  ? 'Environment variable'
                  : 'Config file',
              },
              { key: 'API URL', value: apiUrl },
            ]}
          />
        </Box>

        {/* Context */}
        <Box flexDirection="column">
          <Text bold> Current Context</Text>
          <KeyValue
            pairs={[
              { key: 'Workspace', value: workspaceId ? `#${workspaceId}` : null },
              { key: 'Project', value: projectId ? `#${projectId}` : null },
            ]}
          />
        </Box>

        {/* Workspaces */}
        <Box flexDirection="column">
          <Text bold> Accessible Workspaces</Text>
          {workspaces.length === 0 ? (
            <Text dimColor>  No workspaces found</Text>
          ) : (
            <Box flexDirection="column" marginLeft={2}>
              {workspaces.map((ws, i) => (
                <Text key={i}>
                  <Text dimColor>{i === workspaces.length - 1 ? '\u2514' : '\u251C'}</Text>
                  {' '}
                  {ws.name || 'Unnamed'}
                  <Text dimColor>{` (ID: ${ws.id})`}</Text>
                </Text>
              ))}
            </Box>
          )}
        </Box>

        <Text color="green">  Authentication verified</Text>
      </Box>
    </App>
  );
}

export const whoamiCommand = new Command('whoami')
  .description('Display information about the current authenticated user')
  .option('--json', 'Output as JSON')
  .action((options) => {
    requireAuth();
    const { waitUntilExit } = renderCommand(<WhoamiCommand json={options.json} />);
    waitUntilExit().catch((err) => {
      if (err) {
        process.exit(process.exitCode || 1);
      }
    });
  });
