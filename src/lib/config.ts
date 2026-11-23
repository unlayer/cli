import Conf from 'conf';
import { isJsonMode } from './cli-flags.js';
import { EXIT_USAGE_ERROR } from './exit-codes.js';
import { formatJsonError } from './errors.js';
import { verboseLog } from './verbose.js';
import { getProjectConfig } from './project-config.js';

// ─── Default URLs ─────────────────────────────────────────
export const DEFAULT_API_URL = 'https://api.unlayer.com';
const DEFAULT_CONSOLE_URL = 'https://console.unlayer.com';
const DEFAULT_ACCOUNTS_URL = 'https://accounts.unlayer.com';

// ─── Environment Profiles ─────────────────────────────────
export interface EnvironmentUrls {
  apiUrl: string;
  consoleUrl: string;
  accountsUrl: string;
}

// ─── Config Interface ──────────────────────────────────────
export interface UnlayerConfig {
  token?: string;
  tokenId?: number | null;
  tokenEnvVar?: string;
  apiUrl?: string;
  workspaceId?: number | null;
  projectId?: number | null;
  environments?: Record<string, EnvironmentUrls>;
  activeEnvironment?: string | null;
}

const DEFAULT_TOKEN_ENV_VAR = 'UNLAYER_TOKEN';

const schema = {
  token: {
    type: 'string' as const,
  },
  tokenId: {
    type: ['number', 'null'] as const,
  },
  tokenEnvVar: {
    type: 'string' as const,
    default: DEFAULT_TOKEN_ENV_VAR,
  },
  apiUrl: {
    type: 'string' as const,
    default: DEFAULT_API_URL,
  },
  workspaceId: {
    type: ['number', 'null'] as const,
  },
  projectId: {
    type: ['number', 'null'] as const,
  },
  environments: {
    type: 'object' as const,
    default: {},
  },
  activeEnvironment: {
    type: ['string', 'null'] as const,
    default: null,
  },
};

const config = new Conf<UnlayerConfig>({
  projectName: 'unlayer-cli',
  schema,
});

export function getConfig(): UnlayerConfig {
  return {
    token: config.get('token'),
    tokenEnvVar: config.get('tokenEnvVar'),
    apiUrl: config.get('apiUrl'),
    workspaceId: config.get('workspaceId'),
    projectId: config.get('projectId'),
  };
}

// ─── Environments ─────────────────────────────────────────

/**
 * Get merged environments from both global config and project config.
 * Global config wins on name conflicts.
 */
export function getEnvironments(): Record<string, EnvironmentUrls & { source: 'global' | 'project' }> {
  const projectConfig = getProjectConfig();
  const projectEnvs = (projectConfig as Record<string, unknown>)?.environments as Record<string, EnvironmentUrls> | undefined;
  const globalEnvs = config.get('environments') as Record<string, EnvironmentUrls> | undefined;

  const merged: Record<string, EnvironmentUrls & { source: 'global' | 'project' }> = {};

  // Project envs first (lower priority)
  if (projectEnvs && typeof projectEnvs === 'object') {
    for (const [name, urls] of Object.entries(projectEnvs)) {
      if (urls && typeof urls === 'object' && urls.apiUrl && urls.consoleUrl && urls.accountsUrl) {
        merged[name] = { ...urls, source: 'project' };
      }
    }
  }

  // Global envs override (higher priority)
  if (globalEnvs && typeof globalEnvs === 'object') {
    for (const [name, urls] of Object.entries(globalEnvs)) {
      if (urls && typeof urls === 'object' && urls.apiUrl && urls.consoleUrl && urls.accountsUrl) {
        merged[name] = { ...urls, source: 'global' };
      }
    }
  }

  return merged;
}

/**
 * Get the name of the active environment, or null if none is set.
 */
export function getActiveEnvironment(): string | null {
  return config.get('activeEnvironment') || null;
}

/**
 * Set the active environment by name, or null to clear.
 */
export function setActiveEnvironment(name: string | null): void {
  config.set('activeEnvironment', name);
}

/**
 * Add or update a named environment in the global config.
 */
export function addEnvironment(name: string, urls: EnvironmentUrls): void {
  const envs = (config.get('environments') as Record<string, EnvironmentUrls>) || {};
  envs[name] = urls;
  config.set('environments', envs);
}

/**
 * Remove a named environment from the global config.
 * Returns true if the environment existed and was removed.
 */
export function removeEnvironment(name: string): boolean {
  const envs = (config.get('environments') as Record<string, EnvironmentUrls>) || {};
  if (!(name in envs)) return false;
  delete envs[name];
  config.set('environments', envs);
  // Clear active env if it was the one removed
  if (getActiveEnvironment() === name) {
    setActiveEnvironment(null);
  }
  return true;
}

/**
 * Resolve the URLs for the currently active environment.
 * Returns null if no active environment is set or if the named env doesn't exist.
 */
export function getActiveEnvironmentUrls(): EnvironmentUrls | null {
  const activeName = getActiveEnvironment();
  if (!activeName) return null;
  const envs = getEnvironments();
  const env = envs[activeName];
  if (!env) return null;
  return { apiUrl: env.apiUrl, consoleUrl: env.consoleUrl, accountsUrl: env.accountsUrl };
}

// ─── URLs ─────────────────────────────────────────────────
// UNLAYER_CONSOLE_URL and UNLAYER_ACCOUNTS_URL are intentionally
// undocumented — they exist for internal/development use only.

export function getConsoleUrl(): string {
  const envVar = process.env.UNLAYER_CONSOLE_URL;
  if (envVar) return envVar.replace(/\/+$/, '');
  // Check active environment
  const activeUrls = getActiveEnvironmentUrls();
  if (activeUrls) return activeUrls.consoleUrl.replace(/\/+$/, '');
  return DEFAULT_CONSOLE_URL;
}

export function getAccountsUrl(): string {
  const envVar = process.env.UNLAYER_ACCOUNTS_URL;
  if (envVar) return envVar.replace(/\/+$/, '');
  // Check active environment
  const activeUrls = getActiveEnvironmentUrls();
  if (activeUrls) return activeUrls.accountsUrl.replace(/\/+$/, '');
  return DEFAULT_ACCOUNTS_URL;
}

export function getTokenEnvVar(): string {
  return config.get('tokenEnvVar') || DEFAULT_TOKEN_ENV_VAR;
}

export function setTokenEnvVar(envVar: string): void {
  config.set('tokenEnvVar', envVar);
}

export function getToken(): string | undefined {
  // Check environment variable first (for CI/CD)
  const envVarName = getTokenEnvVar();
  const envToken = process.env[envVarName];
  if (envToken) {
    return envToken;
  }
  return config.get('token');
}

export function setToken(token: string): void {
  config.set('token', token);
}

export function clearToken(): void {
  config.delete('token');
  config.delete('tokenId');
}

export function getTokenId(): number | null | undefined {
  return config.get('tokenId');
}

export function setTokenId(id: number | null): void {
  config.set('tokenId', id);
}

export function getApiUrl(): string {
  // Check environment variable first
  const envUrl = process.env.UNLAYER_API_URL;
  if (envUrl) {
    return envUrl;
  }
  // Check active environment
  const activeUrls = getActiveEnvironmentUrls();
  if (activeUrls) {
    return activeUrls.apiUrl;
  }
  // Check stored config
  const storedUrl = config.get('apiUrl');
  if (storedUrl) {
    return storedUrl;
  }
  return DEFAULT_API_URL;
}

export function setApiUrl(url: string): void {
  config.set('apiUrl', url);
}

export function getWorkspaceId(): number | null | undefined {
  // Check environment variable first (for CI/CD)
  const envId = process.env.UNLAYER_WORKSPACE_ID;
  if (envId) {
    const parsed = parseInt(envId, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return config.get('workspaceId');
}

export function setWorkspaceId(id: number | null): void {
  config.set('workspaceId', id);
}

export function getProjectId(): number | null | undefined {
  // Check environment variable first (for CI/CD)
  const envId = process.env.UNLAYER_PROJECT_ID;
  if (envId) {
    const parsed = parseInt(envId, 10);
    if (!isNaN(parsed)) return parsed;
  }
  // Check global user config (Conf)
  const storedId = config.get('projectId');
  if (storedId !== undefined && storedId !== null) return storedId;
  // Fall back to project config file (unlayer.config.json)
  const projectConfig = getProjectConfig();
  if (projectConfig?.projectId !== undefined && projectConfig.projectId !== null) {
    return projectConfig.projectId;
  }
  return undefined;
}

export function setProjectId(id: number | null): void {
  config.set('projectId', id);
}

export function clearAll(): void {
  config.clear();
}

// ─── Project Config Defaults ──────────────────────────────
// These helpers read from the project-level `unlayer.config.json`
// and fall back to sensible defaults.

/**
 * Default output directory for pull operations.
 * Resolution: project config `defaults.outputDir` > `'./templates'`
 */
export function getDefaultOutputDir(): string {
  const projectConfig = getProjectConfig();
  return projectConfig?.defaults?.outputDir || './templates';
}

export function getConfigPath(): string {
  return config.path;
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated(): boolean {
  return !!getToken();
}

/**
 * Require authentication - exits with error if not authenticated.
 * Outputs JSON-formatted error when --json mode is active.
 */
export function requireAuth(): void {
  verboseLog('Checking authentication...');
  if (!isAuthenticated()) {
    if (isJsonMode()) {
      process.stderr.write(
        formatJsonError('Not authenticated. Run `unlayer login` to get started.', { code: 'AUTH_REQUIRED' }) + '\n',
      );
    } else {
      process.stderr.write('\x1b[31m✗\x1b[0m Not authenticated. Run \x1b[36munlayer login\x1b[0m to get started.\n\n');
    }
    process.exit(EXIT_USAGE_ERROR);
  }
}
