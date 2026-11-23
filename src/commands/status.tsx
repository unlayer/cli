import React, { useState, useEffect } from 'react';
import { Box, Text, useApp } from 'ink';
import { Spinner, StatusMessage } from '@inkjs/ui';
import { Command } from 'commander';
import { App } from '../components/App.js';
import { KeyValue } from '../components/KeyValue.js';
import {
  getApiUrl,
  getWorkspaceId,
  getProjectId,
  getConfigPath,
  isAuthenticated,
} from '../lib/config.js';
import { renderCommand, jsonError, stdoutWrite } from '../lib/render.js';
import { isJsonMode } from '../lib/cli-flags.js';
import { verboseLog } from '../lib/verbose.js';
import { errorMessage } from '../lib/errors.js';

interface StatusResult {
  authenticated: boolean;
  apiReachable: boolean;
  apiLatencyMs: number | null;
  apiUrl: string;
  workspaceId: number | null | undefined;
  projectId: number | null | undefined;
  configPath: string;
  error: string | null;
}

type Step = 'checking' | 'done' | 'error';

interface StatusCommandProps {
  json?: boolean;
}

function StatusCommand({ json: jsonProp }: StatusCommandProps): React.ReactElement {
  const json = jsonProp || isJsonMode();
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('checking');
  const [result, setResult] = useState<StatusResult | null>(null);

  useEffect(() => {
    (async () => {
      const apiUrl = getApiUrl();
      const statusResult: StatusResult = {
        authenticated: isAuthenticated(),
        apiReachable: false,
        apiLatencyMs: null,
        apiUrl,
        workspaceId: getWorkspaceId(),
        projectId: getProjectId(),
        configPath: getConfigPath(),
        error: null,
      };

      // Check API reachability if we have a token
      verboseLog(`API URL: ${apiUrl}`);
      verboseLog(`Authenticated: ${statusResult.authenticated}`);
      if (statusResult.authenticated) {
        try {
          const { createSdkClient } = await import('../lib/sdk-client.js');
          const client = createSdkClient();
          const start = Date.now();
          await client.workspaces.list();
          statusResult.apiLatencyMs = Date.now() - start;
          statusResult.apiReachable = true;
        } catch (err) {
          statusResult.error =
            errorMessage(err, 'API request failed');
        }
      } else {
        // Try a basic fetch to see if the API is at least reachable
        try {
          const start = Date.now();
          const resp = await fetch(`${apiUrl}/health`, {
            signal: AbortSignal.timeout(10_000),
          });
          statusResult.apiLatencyMs = Date.now() - start;
          statusResult.apiReachable = resp.ok || resp.status === 401 || resp.status === 404;
        } catch {
          // Not reachable
        }
      }

      setResult(statusResult);
      setStep('done');
    })();
  }, []);

  useEffect(() => {
    if (step === 'done' && result) {
      if (json) {
        stdoutWrite(JSON.stringify(result, null, 2));
      }
      const healthy = result.authenticated && result.apiReachable;
      const timer = setTimeout(() => {
        if (!healthy) {
          jsonError(
            !result.authenticated
              ? 'Not authenticated'
              : 'API not reachable',
          );
          process.exitCode = 1;
        }
        exit();
      }, 100);
      return () => clearTimeout(timer);
    }
    return;
  }, [step, result, json, exit]);

  if (step === 'checking') {
    return (
      <App>
        <Spinner label="Checking status..." />
      </App>
    );
  }

  if (json || !result) return <></>;

  const healthy = result.authenticated && result.apiReachable;

  return (
    <App>
      <Box flexDirection="column" gap={1}>
        <Text bold> Unlayer CLI Status</Text>

        <Box flexDirection="column">
          <KeyValue
            pairs={[
              {
                key: 'Authenticated',
                value: result.authenticated ? 'Yes' : 'No',
              },
              {
                key: 'API Reachable',
                value: result.apiReachable ? 'Yes' : 'No',
              },
              {
                key: 'API Latency',
                value: result.apiLatencyMs !== null
                  ? `${result.apiLatencyMs}ms`
                  : null,
              },
              { key: 'API URL', value: result.apiUrl },
              { key: 'Workspace ID', value: result.workspaceId },
              { key: 'Project ID', value: result.projectId },
              { key: 'Config File', value: result.configPath },
            ]}
          />
        </Box>

        {result.error && (
          <StatusMessage variant="warning">{result.error}</StatusMessage>
        )}

        <StatusMessage variant={healthy ? 'success' : 'error'}>
          {healthy ? 'All systems operational' : 'Issues detected'}
        </StatusMessage>
      </Box>
    </App>
  );
}

export const statusCommand = new Command('status')
  .description('Check CLI health: auth state, API connectivity, and current context')
  .option('--json', 'Output as JSON')
  .action((options) => {
    const { waitUntilExit } = renderCommand(
      <StatusCommand json={options.json} />,
    );
    waitUntilExit().catch((err) => {
      if (err) process.exit(process.exitCode || 1);
    });
  });
