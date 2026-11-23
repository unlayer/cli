/**
 * E2E tests for the structured `--json` error contract:
 * {"error": "...", "code": "...", "hint"?: "..."} on stderr.
 *
 * Spawns the real built CLI (execFile, so paths with spaces work).
 * Prerequisite: `pnpm build` must have been run before these tests.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CLI = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');

// The CLI cold-starts and the SDK retries network failures with backoff.
vi.setConfig({ testTimeout: 30_000 });

let configHome: string;

beforeAll(() => {
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'unlayer-json-errors-'));
});

afterAll(() => {
  fs.rmSync(configHome, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.UNLAYER_TOKEN;
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        env: {
          ...cleanEnv,
          HOME: configHome,
          USERPROFILE: configHome,
          APPDATA: configHome,
          XDG_CONFIG_HOME: configHome,
          UNLAYER_NON_INTERACTIVE: '1',
          ...env,
        },
      },
      (err, stdout, stderr) => {
        const status = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ status, stdout, stderr });
      },
    );
  });
}

function parseError(stderr: string) {
  const line = stderr.split('\n').find((l) => l.trim().startsWith('{'));
  expect(line, `no JSON error line in stderr: ${stderr}`).toBeDefined();
  return JSON.parse(line as string);
}

describe('--json error contract', () => {
  it('reports AUTH_REQUIRED with a hint and keeps exit code 2', async () => {
    const { status, stdout, stderr } = await run(['template', 'list', '--json']);
    const err = parseError(stderr);
    expect(status).toBe(2);
    expect(stdout).toBe('');
    expect(err.error).toBe('Not authenticated. Run `unlayer login` to get started.');
    expect(err.code).toBe('AUTH_REQUIRED');
    expect(err.hint).toContain('unlayer login');
  });

  it('reports NETWORK when the API is unreachable and keeps exit code 1', async () => {
    const { status, stderr } = await run(['template', 'list', '--json'], {
      UNLAYER_TOKEN: 'unlayer_pat_valid',
      UNLAYER_API_URL: 'http://127.0.0.1:1',
    });
    const err = parseError(stderr);
    expect(status).toBe(1);
    expect(err.code).toBe('NETWORK');
    expect(typeof err.error).toBe('string');
    expect(err.hint).toBeDefined();
  });
});
