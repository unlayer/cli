import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp } from 'ink';
import { PasswordInput, Select, Spinner, StatusMessage } from '@inkjs/ui';
import { Command } from 'commander';
import { App } from '../../components/App.js';
import { KeyValue } from '../../components/KeyValue.js';
import {
  setToken,
  setTokenId,
  getTokenId,
  setApiUrl,
  setWorkspaceId,
  setProjectId,
  getToken,
  getApiUrl,
  DEFAULT_API_URL,
} from '../../lib/config.js';
import { createSdkClient } from '../../lib/sdk-client.js';
import { fetchWorkspacesWithProjects } from '../../lib/workspaces.js';
import type { Project, WorkspaceWithProjects } from '../../lib/types.js';
import { openWithFallback } from '../../lib/browser.js';
import {
  getTokenPageUrl,
  getWorkspaceCreateUrl,
  getProjectCreateUrl,
  getLoginWithCliAuthUrl,
} from '../../lib/urls.js';
import { startAuthServer, type AuthServer } from '../../lib/auth-server.js';
import { renderCommand, jsonError, stdoutWrite, setUsageError } from '../../lib/render.js';
import { isNonInteractive, isJsonMode } from '../../lib/cli-flags.js';
import { errorMessage } from '../../lib/errors.js';


type Step =
  | 'checkExisting'
  | 'browserAuth'
  | 'openBrowser'
  | 'enterToken'
  | 'verifying'
  | 'verified'
  | 'selectWorkspace'
  | 'selectProject'
  | 'done'
  | 'error';

interface LoginCommandProps {
  token?: string;
  url?: string;
  force?: boolean;
  manual?: boolean;
  skipVerify?: boolean;
  skipContext?: boolean;
  workspaceId?: string;
  projectId?: string;
  json?: boolean;
}

function LoginCommand({
  token: tokenFlag,
  url: urlFlag,
  force,
  manual,
  skipVerify,
  skipContext,
  workspaceId: wsIdFlag,
  projectId: projIdFlag,
  json: jsonProp,
}: LoginCommandProps): React.ReactElement {
  const json = jsonProp || isJsonMode();
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('checkExisting');
  const [token, setTokenValue] = useState(tokenFlag || '');
  const [apiUrl] = useState(urlFlag || getApiUrl() || DEFAULT_API_URL);
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceWithProjects[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<WorkspaceWithProjects | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [alreadyLoggedIn, setAlreadyLoggedIn] = useState(false);
  const [authUrl, setAuthUrl] = useState<string>('');
  const authServerRef = useRef<AuthServer | null>(null);

  // Step: Check existing token — no interactive confirmation, just proceed
  useEffect(() => {
    if (step !== 'checkExisting') return;

    // If token provided via flag, go straight to verifying
    if (tokenFlag) {
      if (!tokenFlag.startsWith('unlayer_pat_')) {
        setError('Invalid token format. Token should start with "unlayer_pat_"');
        setStep('error');
        return;
      }
      setStep('verifying');
      return;
    }

    // Non-interactive guard: require --token flag
    if (isNonInteractive()) {
      setUsageError();
      setError('Non-interactive mode: use --token <pat> to authenticate, or set the UNLAYER_TOKEN environment variable.');
      setStep('error');
      return;
    }

    const existingToken = getToken();
    if (existingToken && !force) {
      // Show non-blocking warning but proceed — no confirmation prompt
      setAlreadyLoggedIn(true);
    }

    setStep(manual ? 'openBrowser' : 'browserAuth');
  }, [step, tokenFlag, force, apiUrl, manual]);

  // Step: Browser auth (localhost callback flow)
  useEffect(() => {
    if (step !== 'browserAuth') return;

    let cancelled = false;

    (async () => {
      try {
        const server = await startAuthServer();
        if (cancelled) {
          server.close();
          return;
        }

        authServerRef.current = server;
        const oldTokenId = getTokenId();
        const url = getLoginWithCliAuthUrl(server.port, server.state, oldTokenId);
        setAuthUrl(url);

        await openWithFallback(url);

        const result = await server.waitForAuth();
        if (cancelled) return;

        // Validate token format
        if (!result.token.startsWith('unlayer_pat_')) {
          setError('Received invalid token format from server.');
          setStep('error');
          server.close();
          return;
        }

        setTokenValue(result.token);
        if (result.tokenId) {
          setTokenId(result.tokenId);
        }
        setStep('verifying');
        server.close();
      } catch (err) {
        if (cancelled) return;
        const msg = errorMessage(err, 'Browser authentication failed');
        setError(msg);
        setStep('error');
      }
    })();

    return () => {
      cancelled = true;
      authServerRef.current?.close();
    };
  }, [step]);

  // Step: Open browser for token (manual flow)
  useEffect(() => {
    if (step === 'openBrowser') {
      const url = getTokenPageUrl();
      openWithFallback(url).then(() => {
        setStep('enterToken');
      });
    }
  }, [step]);

  // Step: Verify token
  useEffect(() => {
    if (step !== 'verifying' || !token) return;

    if (skipVerify) {
      setToken(token);
      setApiUrl(apiUrl);
      setStep('done');
      return;
    }

    const client = createSdkClient(token, apiUrl);
    fetchWorkspacesWithProjects(client)
      .then((detailed) => {
        setWorkspaces(detailed);
        setToken(token);
        setApiUrl(apiUrl);
        setStep('verified');
      })
      .catch((err) => {
        const msg = errorMessage(err, 'Verification failed');
        if (msg.includes('401') || msg.includes('Unauthorized')) {
          setError('Invalid token. Please check your token and try again.');
        } else {
          setError(msg);
        }
        setStep('error');
      });
  }, [step, token, apiUrl, skipVerify]);

  // After verified, decide next step — auto-select when possible
  useEffect(() => {
    if (step !== 'verified') return;

    if (skipContext) {
      setStep('done');
      return;
    }

    if (workspaces.length === 0) {
      setStep('done');
      return;
    }

    // Auto-select workspace: flag > single workspace > interactive
    let ws: WorkspaceWithProjects | undefined;
    if (wsIdFlag) {
      const id = parseInt(wsIdFlag, 10);
      ws = workspaces.find((w) => w.id === id);
      if (!ws) {
        setError(`Workspace ID ${wsIdFlag} not found. Available: ${workspaces.map((w) => `${w.id} (${w.name})`).join(', ')}`);
        setStep('error');
        return;
      }
    } else if (workspaces.length === 1) {
      ws = workspaces[0];
    }

    if (ws) {
      setSelectedWorkspace(ws);
      setWorkspaceId(ws.id!);
      setProjectId(null);

      const projects = ws.projects || [];

      // Auto-select project: flag > single project > interactive
      if (projIdFlag) {
        const id = parseInt(projIdFlag, 10);
        const proj = projects.find((p) => p.id === id);
        if (!proj) {
          setError(`Project ID ${projIdFlag} not found in workspace "${ws.name}". Available: ${projects.map((p) => `${p.id} (${p.name})`).join(', ') || 'none'}`);
          setStep('error');
          return;
        }
        setSelectedProject(proj);
        setProjectId(proj.id!);
        setStep('done');
      } else if (projects.length === 1) {
        setSelectedProject(projects[0]);
        setProjectId(projects[0].id!);
        setStep('done');
      } else if (projects.length > 1) {
        if (isNonInteractive()) {
          setUsageError();
          setError(`Non-interactive mode: use --project-id <id> to select a project. Available: ${projects.map((p) => `${p.id} (${p.name})`).join(', ')}`);
          setStep('error');
          return;
        }
        setStep('selectProject');
      } else {
        setStep('done');
      }
    } else {
      if (isNonInteractive()) {
        setUsageError();
        setError(`Non-interactive mode: use --workspace-id <id> to select a workspace. Available: ${workspaces.map((w) => `${w.id} (${w.name})`).join(', ')}`);
        setStep('error');
        return;
      }
      setStep('selectWorkspace');
    }
  }, [step, skipContext, workspaces, wsIdFlag, projIdFlag]);

  const handleTokenSubmit = useCallback((value: string) => {
    if (!value) return;
    if (!value.startsWith('unlayer_pat_')) {
      setError('Invalid token format. Token should start with "unlayer_pat_"');
      setStep('error');
      return;
    }
    setTokenValue(value);
    setStep('verifying');
  }, []);

  const handleWorkspaceSelect = useCallback((value: string) => {
    if (value === '__create__') {
      openWithFallback(getWorkspaceCreateUrl());
      return;
    }
    const wsId = parseInt(value, 10);
    const ws = workspaces.find((w) => w.id === wsId);
    if (ws) {
      setSelectedWorkspace(ws);
      setWorkspaceId(wsId);
      setProjectId(null);
      if (ws.projects && ws.projects.length > 0) {
        setStep('selectProject');
      } else {
        setStep('done');
      }
    }
  }, [workspaces]);

  const handleProjectSelect = useCallback((value: string) => {
    if (value === '__create__' && selectedWorkspace) {
      openWithFallback(
        getProjectCreateUrl(selectedWorkspace.id!),
      );
      return;
    }
    const projId = parseInt(value, 10);
    const proj = selectedWorkspace?.projects?.find((p) => p.id === projId);
    if (proj) {
      setSelectedProject(proj);
      setProjectId(projId);
      setStep('done');
    }
  }, [selectedWorkspace]);

  // JSON output on success
  useEffect(() => {
    if (step === 'done' && json) {
      stdoutWrite(JSON.stringify({
        status: 'authenticated',
        apiUrl,
        workspace: selectedWorkspace ? { id: selectedWorkspace.id, name: selectedWorkspace.name } : null,
        project: selectedProject ? { id: selectedProject.id, name: selectedProject.name } : null,
      }, null, 2));
    }
  }, [step, json, apiUrl, selectedWorkspace, selectedProject]);

  // Auto-exit on terminal states
  useEffect(() => {
    if (step === 'done') {
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

  return (
    <App>
      {/* Check existing */}
      {step === 'checkExisting' && (
        <Spinner label="Checking existing credentials..." />
      )}

      {/* Browser auth (localhost callback) */}
      {step === 'browserAuth' && (
        <Box flexDirection="column" gap={1}>
          {alreadyLoggedIn && (
            <StatusMessage variant="warning">
              Existing session found. Re-authenticating...
            </StatusMessage>
          )}
          <StatusMessage variant="info">
            Opening browser for authentication...
          </StatusMessage>
          <Spinner label="Waiting for authentication..." />
          {authUrl ? (
            <>
              <Box marginLeft={4}>
                <Text dimColor>If the browser didn't open, visit:</Text>
              </Box>
              <Box marginLeft={4}>
                <Text dimColor>{authUrl}</Text>
              </Box>
            </>
          ) : null}
          <Box marginLeft={4}>
            <Text dimColor>Or use: unlayer login --manual</Text>
          </Box>
        </Box>
      )}

      {/* Open browser & enter token (manual flow) */}
      {(step === 'openBrowser' || step === 'enterToken') && (
        <Box flexDirection="column" gap={1}>
          <StatusMessage variant="info">
            Opening browser to get your token...
          </StatusMessage>
          <Box marginLeft={4}>
            <Text dimColor>{getTokenPageUrl()}</Text>
          </Box>
          {step === 'enterToken' && !isNonInteractive() && (
            <Box marginTop={1}>
              <Text>  Paste your Personal Access Token: </Text>
              <PasswordInput
                placeholder="unlayer_pat_..."
                onSubmit={handleTokenSubmit}
              />
            </Box>
          )}
        </Box>
      )}

      {/* Verifying */}
      {step === 'verifying' && (
        <Spinner label="Verifying credentials..." />
      )}

      {/* Select workspace */}
      {step === 'selectWorkspace' && !isNonInteractive() && (
        <Box flexDirection="column" gap={1}>
          <StatusMessage variant="success">
            Successfully authenticated!
          </StatusMessage>
          <Box>
            <Text>  Select a workspace:</Text>
          </Box>
          <Select
            options={[
              ...workspaces.map((ws) => ({
                label: ws.name || 'Unnamed',
                value: String(ws.id),
              })),
              {
                label: '+ Create new workspace (opens browser)',
                value: '__create__',
              },
            ]}
            onChange={handleWorkspaceSelect}
          />
        </Box>
      )}

      {/* Select project */}
      {step === 'selectProject' && !isNonInteractive() && selectedWorkspace && (
        <Box flexDirection="column" gap={1}>
          <StatusMessage variant="success">
            Successfully authenticated!
          </StatusMessage>
          <StatusMessage variant="info">
            {`Workspace: ${selectedWorkspace.name}`}
          </StatusMessage>
          <Box>
            <Text>  Select a project:</Text>
          </Box>
          <Select
            options={[
              ...(selectedWorkspace.projects || []).map((proj) => ({
                label: proj.name || 'Unnamed',
                value: String(proj.id),
              })),
              {
                label: '+ Create new project (opens browser)',
                value: '__create__',
              },
            ]}
            onChange={handleProjectSelect}
          />
        </Box>
      )}

      {/* Done */}
      {step === 'done' && (
        <Box flexDirection="column" gap={1}>
          <StatusMessage variant="success">
            {skipVerify
              ? 'Credentials saved (unverified)'
              : 'Successfully authenticated!'}
          </StatusMessage>
          <KeyValue pairs={[{ key: 'API URL', value: apiUrl }]} />
          {selectedWorkspace && selectedProject && (
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
          )}
          <Text color="green">  Login complete</Text>
        </Box>
      )}

      {/* Error */}
      {step === 'error' && error && (
        <Box flexDirection="column" gap={1}>
          <StatusMessage variant="error">{error}</StatusMessage>
          <Box marginLeft={4}>
            <Text dimColor>
              Create a new token at: {getTokenPageUrl()}
            </Text>
          </Box>
        </Box>
      )}
    </App>
  );
}

export const loginCommand = new Command('login')
  .description(
    'Authenticate with your Unlayer account',
  )
  .option('-t, --token <token>', 'Personal Access Token (skip browser flow)')
  .option('-u, --url <url>', 'API URL (default: https://api.unlayer.com)')
  .option('-f, --force', 'Overwrite existing authentication (default behavior, kept for backward compatibility)')
  .option('-m, --manual', 'Use manual token entry instead of browser auth')
  .option('--workspace-id <id>', 'Auto-select workspace by ID (agent-friendly)')
  .option('--project-id <id>', 'Auto-select project by ID (agent-friendly)')
  .option('--skip-verify', 'Skip token verification (for local development)')
  .option('--skip-context', 'Skip workspace/project selection after login')
  .option('--json', 'Output as JSON')
  .action((options) => {
    const { waitUntilExit } = renderCommand(
      <LoginCommand
        token={options.token}
        url={options.url}
        force={options.force}
        manual={options.manual}
        workspaceId={options.workspaceId}
        projectId={options.projectId}
        skipVerify={options.skipVerify}
        skipContext={options.skipContext}
        json={options.json}
      />,
    );
    waitUntilExit().catch((err) => {
      if (err) {
        process.exit(process.exitCode || 1);
      }
    });
  });
