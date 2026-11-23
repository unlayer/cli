import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp } from 'ink';
import { Select, TextInput, PasswordInput, ConfirmInput, Spinner, StatusMessage } from '@inkjs/ui';
import { Command } from 'commander';
import { App } from '../components/App.js';
import { KeyValue } from '../components/KeyValue.js';
import {
  isAuthenticated,
  setToken,
  setApiUrl,
  setWorkspaceId,
  setProjectId,
  getApiUrl,
} from '../lib/config.js';
import { createSdkClient } from '../lib/sdk-client.js';
import { fetchWorkspacesWithProjects } from '../lib/workspaces.js';
import type { Project, WorkspaceWithProjects } from '../lib/types.js';
import { openWithFallback } from '../lib/browser.js';
import {
  getTokenPageUrl,
  getWorkspaceCreateUrl,
  getProjectCreateUrl,
} from '../lib/urls.js';
import { renderCommand, jsonError, stdoutWrite, setUsageError } from '../lib/render.js';
import { isNonInteractive, isJsonMode } from '../lib/cli-flags.js';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { errorMessage } from '../lib/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Types ──────────────────────────────────────────────────
type Framework = 'nextjs' | 'vite-react' | 'vite-vue' | 'nuxt' | 'vanilla';
type Template = 'adventure' | 'product' | 'blank';

type InitStep =
  | 'getName'
  | 'getFramework'
  | 'getTemplate'
  | 'getTypeScript'
  | 'creating'
  | 'created'
  | 'askInstall'
  | 'installing'
  | 'installed'
  | 'askConnect'
  | 'autoConnect'
  | 'connectLogin'
  | 'connectVerifying'
  | 'connectSelectWorkspace'
  | 'connectSelectProject'
  | 'done'
  | 'error';

// ─── Constants ──────────────────────────────────────────────
const FRAMEWORK_OPTIONS = [
  { value: 'nextjs', label: 'Next.js' },
  { value: 'vite-react', label: 'Vite + React' },
  { value: 'vite-vue', label: 'Vite + Vue' },
  { value: 'nuxt', label: 'Nuxt' },
  { value: 'vanilla', label: 'Vanilla HTML' },
];

const TEMPLATE_OPTIONS = [
  { value: 'adventure', label: 'Adventure - Travel newsletter' },
  { value: 'product', label: 'Product - Apple-style announcement' },
  { value: 'blank', label: 'Blank - Start from scratch' },
];

// ─── Helpers ─────────────────────────────────────────────────

/** Write projectId into unlayer.config.json (non-fatal on failure). */
function patchConfigProjectId(projectDir: string, projectId: number): void {
  const configPath = path.join(projectDir, 'unlayer.config.json');
  if (!fs.existsSync(configPath)) return;
  try {
    const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    content.projectId = projectId;
    fs.writeFileSync(configPath, JSON.stringify(content, null, 2));
  } catch {
    // Non-fatal — config file may be malformed
  }
}

// ─── Scaffolding helpers ─────────────────────────────────────
function getTemplatesDir(): string {
  const srcTemplates = path.join(__dirname, '..', 'templates');
  const distTemplates = path.join(__dirname, 'templates');
  // Check that the directory actually contains framework scaffolds (e.g. nextjs/),
  // not just pulled template JSON files from `unlayer pull`.
  if (fs.existsSync(srcTemplates) && fs.existsSync(path.join(srcTemplates, 'nextjs'))) {
    return srcTemplates;
  }
  return distTemplates;
}

function copyDir(
  src: string,
  dest: string,
  replacements: Record<string, string> = {},
): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, replacements);
    } else {
      let content = fs.readFileSync(srcPath, 'utf-8');
      for (const [key, value] of Object.entries(replacements)) {
        content = content.replace(new RegExp(`{{${key}}}`, 'g'), value);
      }
      fs.writeFileSync(destPath, content);
    }
  }
}

function copyDemoTemplate(
  template: Template,
  destDir: string,
  framework: Framework,
): void {
  let designsDir: string;
  if (framework === 'vanilla') {
    designsDir = path.join(destDir, 'designs');
  } else {
    designsDir = path.join(destDir, 'public', 'designs');
  }
  fs.mkdirSync(designsDir, { recursive: true });

  if (template === 'blank') {
    const blankTemplate = {
      counters: { u_row: 1, u_column: 1, u_content_text: 1 },
      body: {
        rows: [
          {
            cells: [1],
            columns: [
              {
                contents: [
                  {
                    type: 'text',
                    values: {
                      containerPadding: '10px',
                      text: '<p style="font-size: 14px;">Start designing your email here!</p>',
                    },
                  },
                ],
                values: { padding: '0px', backgroundColor: '' },
              },
            ],
            values: {
              padding: '10px',
              backgroundColor: '',
              columnsBackgroundColor: '',
            },
          },
        ],
        values: {
          backgroundColor: '#ffffff',
          contentWidth: '600px',
          fontFamily: {
            label: 'Arial',
            value: 'arial,helvetica,sans-serif',
          },
        },
      },
    };
    fs.writeFileSync(
      path.join(designsDir, 'sample.json'),
      JSON.stringify(blankTemplate, null, 2),
    );
  } else {
    const demoFile = template === 'adventure' ? 'adventure.json' : 'product.json';
    const possiblePaths = [
      path.join(__dirname, '..', 'data', demoFile),
      path.join(__dirname, 'data', demoFile),
    ];

    let srcPath: string | null = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        srcPath = p;
        break;
      }
    }

    if (srcPath) {
      fs.copyFileSync(srcPath, path.join(designsDir, 'sample.json'));
    } else {
      copyDemoTemplate('blank', destDir, framework);
    }
  }
}

function patchProjectIdInSource(
  projectDir: string,
  framework: Framework,
  projectId: number,
): void {
  const editorFiles: Record<Framework, string> = {
    nextjs: path.join(projectDir, 'app', 'editor', 'page.tsx'),
    'vite-react': path.join(projectDir, 'src', 'pages', 'Editor.tsx'),
    'vite-vue': path.join(projectDir, 'src', 'pages', 'Editor.vue'),
    nuxt: path.join(projectDir, 'pages', 'editor.vue'),
    vanilla: path.join(projectDir, 'editor.html'),
  };

  const filePath = editorFiles[framework];
  if (!filePath || !fs.existsSync(filePath)) return;

  try {
    let content = fs.readFileSync(filePath, 'utf-8');
    // JS/TS/HTML templates use: projectId: 0
    content = content.replace(/projectId:\s*0/, `projectId: ${projectId}`);
    // Vue templates use: :project-id="0"
    content = content.replace(/:project-id="0"/, `:project-id="${projectId}"`);
    fs.writeFileSync(filePath, content);
  } catch {
    // Non-fatal
  }
}

function detectPackageManager(): 'npm' | 'yarn' | 'pnpm' {
  try {
    execSync('pnpm --version', { stdio: 'ignore' });
    return 'pnpm';
  } catch {
    try {
      execSync('yarn --version', { stdio: 'ignore' });
      return 'yarn';
    } catch {
      return 'npm';
    }
  }
}

function installDependencies(
  projectDir: string,
  packageManager: string,
): void {
  const commands: Record<string, string> = {
    npm: 'npm install',
    yarn: 'yarn',
    pnpm: 'pnpm install --ignore-workspace',
  };
  execSync(commands[packageManager], {
    cwd: projectDir,
    stdio: 'inherit',
    timeout: 300_000, // 5 minute timeout
    env: { ...process.env, npm_config_workspace: '' },
  });
}

// ─── Component ──────────────────────────────────────────────
interface InitCommandProps {
  projectName?: string;
  framework?: string;
  template?: string;
  install?: boolean;
  typescript?: boolean;
  skipConnect?: boolean;
  outputDir?: string;
  json?: boolean;
  workspaceId?: string;
  projectId?: string;
}

function InitCommand({
  projectName: initialName,
  framework: initialFramework,
  template: initialTemplate,
  install: shouldInstall,
  typescript: initialTypeScript,
  skipConnect,
  outputDir,
  json: jsonProp,
  workspaceId: workspaceIdProp,
  projectId: projectIdProp,
}: InitCommandProps): React.ReactElement {
  const json = jsonProp || isJsonMode();
  const { exit } = useApp();
  const [step, setStep] = useState<InitStep>(() => {
    if (initialName) return 'getFramework';
    if (isNonInteractive()) return 'error';
    return 'getName';
  });
  const [name, setName] = useState(initialName || '');
  const [framework, setFramework] = useState<Framework | null>(
    (initialFramework as Framework) || null,
  );
  const [template, setTemplate] = useState<Template | null>(
    (initialTemplate as Template) || null,
  );
  const [useTypeScript, setUseTypeScript] = useState(initialTypeScript ?? true);
  const [error, setError] = useState<string | null>(() => {
    if (!initialName && isNonInteractive()) {
      setUsageError();
      return 'Non-interactive mode: provide a project-name argument. Usage: unlayer init <project-name> -f <framework> -t <template>';
    }
    return null;
  });
  const [packageManager] = useState(detectPackageManager);
  const [completedSteps, setCompletedSteps] = useState<string[]>([]);

  // Connect flow state
  const [workspaces, setWorkspaces] = useState<WorkspaceWithProjects[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<WorkspaceWithProjects | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);

  // Auto-advance when flags are provided
  useEffect(() => {
    if (step === 'getFramework' && initialFramework) {
      const validFrameworks = FRAMEWORK_OPTIONS.map(o => o.value);
      if (!validFrameworks.includes(initialFramework)) {
        setError(`Invalid framework: ${initialFramework}. Use: ${validFrameworks.join(', ')}`);
        setStep('error');
        return;
      }
      if (initialTemplate) {
        const validTemplates = TEMPLATE_OPTIONS.map(o => o.value);
        if (!validTemplates.includes(initialTemplate)) {
          setError(`Invalid template: ${initialTemplate}. Use: ${validTemplates.join(', ')}`);
          setStep('error');
          return;
        }
        setStep('getTypeScript');
      } else {
        setStep('getTemplate');
      }
    } else if (step === 'getFramework' && !initialFramework && isNonInteractive()) {
      setUsageError();
      setError(`Non-interactive mode: use --framework <${FRAMEWORK_OPTIONS.map(o => o.value).join('|')}>.`);
      setStep('error');
    }
  }, [step, initialFramework, initialTemplate]);

  useEffect(() => {
    if (step === 'getTemplate' && initialTemplate) {
      const validTemplates = TEMPLATE_OPTIONS.map(o => o.value);
      if (!validTemplates.includes(initialTemplate)) {
        setError(`Invalid template: ${initialTemplate}. Use: ${validTemplates.join(', ')}`);
        setStep('error');
        return;
      }
      setStep('getTypeScript');
    } else if (step === 'getTemplate' && !initialTemplate && isNonInteractive()) {
      setUsageError();
      setError(`Non-interactive mode: use --template <${TEMPLATE_OPTIONS.map(o => o.value).join('|')}>.`);
      setStep('error');
    }
  }, [step, initialTemplate]);

  useEffect(() => {
    if (step === 'getTypeScript' && (initialFramework || framework === 'vanilla')) {
      // Auto-proceed with default (TypeScript true) in non-interactive mode
      setStep('creating');
    } else if (step === 'getTypeScript' && isNonInteractive()) {
      // Default to TypeScript true in NI mode
      setUseTypeScript(true);
      setStep('creating');
    }
  }, [step, initialFramework, framework]);

  // Resolve project directory — uses --output-dir if provided, otherwise cwd
  const resolveProjectDir = useCallback(
    (projectName: string) =>
      outputDir
        ? path.resolve(outputDir, projectName)
        : path.resolve(projectName),
    [outputDir],
  );

  // Create project
  useEffect(() => {
    if (step !== 'creating') return;

    try {
      const projectDir = resolveProjectDir(name);

      if (fs.existsSync(projectDir)) {
        const contents = fs.readdirSync(projectDir);
        if (contents.length > 0) {
          setError(`Directory "${name}" already exists and is not empty`);
          setStep('error');
          return;
        }
      }

      const templatesDir = getTemplatesDir();
      const frameworkDir = path.join(templatesDir, framework!);

      if (!fs.existsSync(frameworkDir)) {
        setError(`Framework template not found: ${framework}`);
        setStep('error');
        return;
      }

      const replacements = {
        PROJECT_NAME: name,
        USE_TYPESCRIPT: useTypeScript ? 'true' : 'false',
        PROJECT_ID: '0',
      };

      copyDir(frameworkDir, projectDir, replacements);
      copyDemoTemplate(template!, projectDir, framework!);

      fs.mkdirSync(path.join(projectDir, 'output'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'output', '.gitkeep'), '');

      const gitignorePath = path.join(projectDir, '.gitignore');
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(
          gitignorePath,
          `node_modules/\n.next/\ndist/\noutput/*.html\noutput/*.pdf\noutput/*.png\noutput/*.zip\n.env.local\n.DS_Store\n`,
        );
      }

      fs.writeFileSync(
        path.join(projectDir, 'unlayer.config.json'),
        JSON.stringify(
          {
            $schema: 'https://unlayer.com/cli/config-schema.json',
            projectId: null,
            defaults: {
              outputDir: './output',
            },
          },
          null,
          2,
        ),
      );

      setCompletedSteps((prev) => [...prev, 'created']);
      setStep('created');
    } catch (err) {
      setError(errorMessage(err, 'Failed to create project'));
      setStep('error');
    }
  }, [step, name, framework, template, useTypeScript]);

  // After created, decide next step
  const hasPartialConnect = !!(workspaceIdProp || projectIdProp) && !(workspaceIdProp && projectIdProp);
  const hasAutoConnect = !!(workspaceIdProp && projectIdProp && isAuthenticated());

  // Warn (via stderr) when only one of the two connect flags is provided
  useEffect(() => {
    if (step === 'created' && hasPartialConnect) {
      process.stderr.write(
        'Warning: Both --workspace-id and --project-id are required to auto-connect. Skipping connect.\n',
      );
    }
  }, [step, hasPartialConnect]);
  useEffect(() => {
    if (step !== 'created') return;

    if (framework === 'vanilla' || shouldInstall === false) {
      if (hasAutoConnect) {
        setStep('autoConnect');
      } else {
        setStep(skipConnect || isNonInteractive() ? 'done' : 'askConnect');
      }
    } else if (isNonInteractive()) {
      // Auto-install in non-interactive mode
      setStep('installing');
      try {
        installDependencies(resolveProjectDir(name), packageManager);
        setCompletedSteps((prev) => [...prev, 'installed']);
        setStep(hasAutoConnect ? 'autoConnect' : 'done');
      } catch {
        // Non-fatal, continue
        setStep(hasAutoConnect ? 'autoConnect' : 'done');
      }
    } else {
      setStep('askInstall');
    }
  }, [step, framework, shouldInstall, skipConnect, name, packageManager, hasAutoConnect]);

  // Name submitted
  const handleNameSubmit = useCallback((value: string) => {
    if (!value) return;
    setName(value);
    setStep('getFramework');
  }, []);

  // Framework selected
  const handleFrameworkSelect = useCallback((value: string) => {
    setFramework(value as Framework);
    setStep('getTemplate');
  }, []);

  // Template selected
  const handleTemplateSelect = useCallback((value: string) => {
    setTemplate(value as Template);
    if (framework === 'vanilla') {
      setStep('creating');
    } else {
      setStep('getTypeScript');
    }
  }, [framework]);

  // TypeScript confirmed/cancelled
  const handleTypeScriptConfirm = useCallback(() => {
    setUseTypeScript(true);
    setStep('creating');
  }, []);

  const handleTypeScriptCancel = useCallback(() => {
    setUseTypeScript(false);
    setStep('creating');
  }, []);

  // Install confirmed/cancelled
  const handleInstallConfirm = useCallback(() => {
    setStep('installing');
    try {
      installDependencies(resolveProjectDir(name), packageManager);
      setCompletedSteps((prev) => [...prev, 'installed']);
      setStep('installed');
    } catch {
      // Non-fatal, continue
      setStep(skipConnect ? 'done' : 'askConnect');
    }
  }, [name, packageManager, skipConnect]);

  const handleInstallCancel = useCallback(() => {
    setStep(skipConnect ? 'done' : 'askConnect');
  }, [skipConnect]);

  // After installed
  useEffect(() => {
    if (step === 'installed') {
      if (hasAutoConnect) {
        setStep('autoConnect');
      } else {
        setStep(skipConnect ? 'done' : 'askConnect');
      }
    }
  }, [step, skipConnect, hasAutoConnect]);

  // Auto-connect flow (non-interactive, driven by --workspace-id and --project-id flags)
  useEffect(() => {
    if (step !== 'autoConnect') return;

    const wsId = parseInt(workspaceIdProp!, 10);
    const projId = parseInt(projectIdProp!, 10);

    if (Number.isNaN(wsId)) {
      setError(`Invalid --workspace-id: "${workspaceIdProp}" is not a number`);
      setStep('error');
      return;
    }
    if (Number.isNaN(projId)) {
      setError(`Invalid --project-id: "${projectIdProp}" is not a number`);
      setStep('error');
      return;
    }

    const client = createSdkClient();

    fetchWorkspacesWithProjects(client)
      .then((detailed) => {
        const ws = detailed.find((w) => w.id === wsId);
        if (!ws) {
          setError(`Workspace ${wsId} not found`);
          setStep('error');
          return;
        }
        const proj = ws.projects?.find((p) => p.id === projId);
        if (!proj) {
          setError(`Project ${projId} not found in workspace "${ws.name}"`);
          setStep('error');
          return;
        }

        setSelectedWorkspace(ws);
        setSelectedProject(proj);
        setWorkspaceId(wsId);
        setProjectId(projId);

        const projectDir = resolveProjectDir(name);
        patchConfigProjectId(projectDir, projId);
        if (framework) patchProjectIdInSource(projectDir, framework, projId);

        setStep('done');
      })
      .catch((err) => {
        setError(errorMessage(err, 'API error', 'Failed to connect: '));
        setStep('error');
      });
  }, [step]);

  // Connect flow
  const handleConnectConfirm = useCallback(() => {
    if (isAuthenticated()) {
      setStep('connectVerifying');
      const client = createSdkClient();
      fetchWorkspacesWithProjects(client)
        .then((detailed) => {
          setWorkspaces(detailed);
          if (detailed.length > 0) {
            setStep('connectSelectWorkspace');
          } else {
            setStep('done');
          }
        })
        .catch(() => {
          // Token invalid, ask for login
          setStep('connectLogin');
          openWithFallback(getTokenPageUrl());
        });
    } else {
      setStep('connectLogin');
      openWithFallback(getTokenPageUrl());
    }
  }, []);

  const handleConnectCancel = useCallback(() => {
    setStep('done');
  }, []);

  // Login token submit
  const handleLoginTokenSubmit = useCallback((value: string) => {
    if (!value || !value.startsWith('unlayer_pat_')) return;
    setToken(value);
    setApiUrl(getApiUrl());
    setStep('connectVerifying');

    const client = createSdkClient(value);
    fetchWorkspacesWithProjects(client)
      .then((detailed) => {
        setWorkspaces(detailed);
        if (detailed.length > 0) {
          setStep('connectSelectWorkspace');
        } else {
          setStep('done');
        }
      })
      .catch(() => {
        setStep('done');
      });
  }, []);

  const handleConnectWorkspaceSelect = useCallback(
    (value: string) => {
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
          setStep('connectSelectProject');
        } else {
          setStep('done');
        }
      }
    },
    [workspaces],
  );

  const handleConnectProjectSelect = useCallback(
    (value: string) => {
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

        const projectDir = resolveProjectDir(name);
        patchConfigProjectId(projectDir, projId);
        if (framework) patchProjectIdInSource(projectDir, framework, projId);

        setStep('done');
      }
    },
    [selectedWorkspace, name],
  );

  // JSON output on success
  useEffect(() => {
    if (step === 'done' && json) {
      stdoutWrite(JSON.stringify({
        project: name,
        framework,
        template,
        typescript: useTypeScript,
        path: resolveProjectDir(name),
        workspace: selectedWorkspace ? { id: selectedWorkspace.id, name: selectedWorkspace.name } : null,
        project_connection: selectedProject ? { id: selectedProject.id, name: selectedProject.name } : null,
      }, null, 2));
    }
  }, [step, json, name, framework, template, useTypeScript, selectedWorkspace, selectedProject]);

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

  const runCmd = packageManager === 'npm' ? 'npm run' : packageManager;

  return (
    <App>
      {/* Get project name */}
      {step === 'getName' && !isNonInteractive() && (
        <Box>
          <Text>  Project name: </Text>
          <TextInput
            defaultValue="my-unlayer-app"
            onSubmit={handleNameSubmit}
          />
        </Box>
      )}

      {/* Get framework */}
      {step === 'getFramework' && !isNonInteractive() && (
        <Box flexDirection="column" gap={1}>
          <Text>  Select a framework:</Text>
          <Select options={FRAMEWORK_OPTIONS} onChange={handleFrameworkSelect} />
        </Box>
      )}

      {/* Get template */}
      {step === 'getTemplate' && !isNonInteractive() && (
        <Box flexDirection="column" gap={1}>
          <Text>  Select a starter template:</Text>
          <Select options={TEMPLATE_OPTIONS} onChange={handleTemplateSelect} />
        </Box>
      )}

      {/* Get TypeScript preference */}
      {step === 'getTypeScript' && !isNonInteractive() && framework !== 'vanilla' && (
        <Box>
          <Text>  Use TypeScript? </Text>
          <ConfirmInput
            defaultChoice="confirm"
            onConfirm={handleTypeScriptConfirm}
            onCancel={handleTypeScriptCancel}
          />
        </Box>
      )}

      {/* Creating */}
      {step === 'creating' && (
        <Spinner label="Creating project..." />
      )}

      {/* Ask install */}
      {step === 'askInstall' && !isNonInteractive() && (
        <Box flexDirection="column" gap={1}>
          <StatusMessage variant="success">Project created!</StatusMessage>
          <Box>
            <Text>  Install dependencies with {packageManager}? </Text>
            <ConfirmInput
              defaultChoice="confirm"
              onConfirm={handleInstallConfirm}
              onCancel={handleInstallCancel}
            />
          </Box>
        </Box>
      )}

      {/* Installing */}
      {step === 'installing' && (
        <Box flexDirection="column">
          <StatusMessage variant="success">Project created!</StatusMessage>
          <Spinner label={`Installing dependencies with ${packageManager}...`} />
        </Box>
      )}

      {/* Ask connect */}
      {step === 'askConnect' && !isNonInteractive() && (
        <Box flexDirection="column" gap={1}>
          <StatusMessage variant="success">Project created!</StatusMessage>
          {completedSteps.includes('installed') && (
            <StatusMessage variant="success">
              Dependencies installed
            </StatusMessage>
          )}
          <Box>
            <Text>  Connect to your Unlayer account? </Text>
            <ConfirmInput
              defaultChoice="confirm"
              onConfirm={handleConnectConfirm}
              onCancel={handleConnectCancel}
            />
          </Box>
        </Box>
      )}

      {/* Connect login */}
      {step === 'connectLogin' && !isNonInteractive() && (
        <Box flexDirection="column" gap={1}>
          <StatusMessage variant="success">Project created!</StatusMessage>
          <StatusMessage variant="info">
            Opening browser for authentication...
          </StatusMessage>
          <Box marginLeft={4}>
            <Text dimColor>{getTokenPageUrl()}</Text>
          </Box>
          <Box marginTop={1}>
            <Text>  Paste your Personal Access Token: </Text>
            <PasswordInput
              placeholder="unlayer_pat_..."
              onSubmit={handleLoginTokenSubmit}
            />
          </Box>
        </Box>
      )}

      {/* Connect verifying */}
      {step === 'connectVerifying' && (
        <Box flexDirection="column">
          <StatusMessage variant="success">Project created!</StatusMessage>
          <Spinner label="Connecting to Unlayer..." />
        </Box>
      )}

      {/* Connect select workspace */}
      {step === 'connectSelectWorkspace' && !isNonInteractive() && (
        <Box flexDirection="column" gap={1}>
          <StatusMessage variant="success">Project created!</StatusMessage>
          <StatusMessage variant="success">Connected to Unlayer</StatusMessage>
          <Text>  Select a workspace:</Text>
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
            onChange={handleConnectWorkspaceSelect}
          />
        </Box>
      )}

      {/* Connect select project */}
      {step === 'connectSelectProject' && !isNonInteractive() && selectedWorkspace && (
        <Box flexDirection="column" gap={1}>
          <StatusMessage variant="success">Project created!</StatusMessage>
          <StatusMessage variant="success">Connected to Unlayer</StatusMessage>
          <StatusMessage variant="info">
            {`Workspace: ${selectedWorkspace.name}`}
          </StatusMessage>
          <Text>  Select a project:</Text>
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
            onChange={handleConnectProjectSelect}
          />
        </Box>
      )}

      {/* Done */}
      {step === 'done' && (
        <Box flexDirection="column" gap={1}>
          <StatusMessage variant="success">
            Project created successfully!
          </StatusMessage>
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
          <Box flexDirection="column" marginTop={1}>
            <Text>  Next steps:</Text>
            <Text>{''}</Text>
            <Text>    cd {path.relative(process.cwd(), resolveProjectDir(name)) || '.'}</Text>
            {framework === 'vanilla' ? (
              <Text>    open editor.html</Text>
            ) : (
              <Text>    {runCmd} dev</Text>
            )}
          </Box>
          <Box marginTop={1}>
            <Text color="green">  Happy designing!</Text>
          </Box>
        </Box>
      )}

      {/* Error */}
      {step === 'error' && error && (
        <StatusMessage variant="error">{error}</StatusMessage>
      )}
    </App>
  );
}

export const initCommand = new Command('init')
  .description('Create a new Unlayer project with the email editor')
  .argument('[project-name]', 'Name of the project')
  .option(
    '-f, --framework <framework>',
    'Framework to use (nextjs, vite-react, vite-vue, nuxt, vanilla)',
  )
  .option(
    '-t, --template <template>',
    'Starter template (adventure, product, blank)',
  )
  .option('--no-install', 'Skip installing dependencies')
  .option('--no-typescript', 'Disable TypeScript (enabled by default)')
  .option('--skip-connect', 'Skip account connection after scaffolding')
  .option('--workspace-id <id>', 'Workspace ID to connect (non-interactive)')
  .option('--project-id <id>', 'Project ID to connect (non-interactive)')
  .option('-o, --output-dir <dir>', 'Directory to create the project in (defaults to cwd)')
  .option('--json', 'Output as JSON')
  .addHelpText(
    'after',
    `
Examples:
  $ unlayer init                           # Interactive mode
  $ unlayer init my-email-app              # Create project with prompts
  $ unlayer init my-app -f nextjs          # Create Next.js project
  $ unlayer init my-app -f vanilla -t product
  $ unlayer init my-app --skip-connect     # Skip account connection
  $ unlayer init my-app -f nextjs -t adventure --workspace-id 1 --project-id 42  # CI auto-connect
`,
  )
  .action((projectName, options) => {
    const { waitUntilExit } = renderCommand(
      <InitCommand
        projectName={projectName}
        framework={options.framework}
        template={options.template}
        install={options.install}
        typescript={options.typescript}
        skipConnect={options.skipConnect}
        outputDir={options.outputDir}
        json={options.json}
        workspaceId={options.workspaceId}
        projectId={options.projectId}
      />,
    );
    waitUntilExit().catch((err) => {
      if (err) {
        process.exit(process.exitCode || 1);
      }
    });
  });
