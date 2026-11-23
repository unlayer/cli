/**
 * Stable machine-readable error codes for `--json` mode.
 *
 * Errors are written to stderr as `{"error": "...", "code": "...", "hint": "..."}`.
 * `error` is the human-readable message and is unchanged from earlier versions;
 * `code` is a stable identifier scripts can switch on; `hint` is an optional
 * next step. Exit codes are not affected by the code.
 */

import Unlayer from '@unlayer/sdk';

export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'NETWORK'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'UNKNOWN';

export interface ErrorInfo {
  code: ErrorCode;
  hint?: string;
}

const DEFAULT_HINTS: Partial<Record<ErrorCode, string>> = {
  AUTH_REQUIRED: 'Run `unlayer login` or set the UNLAYER_TOKEN environment variable.',
  INVALID_INPUT: 'Check the command arguments and flags; run with --help for usage.',
  NOT_FOUND: 'Check the ID, or use the matching `list` command to see what exists.',
  NETWORK: 'Check your network connection and --api-url, then retry.',
  RATE_LIMITED: 'Wait a moment and retry.',
  SERVER_ERROR: 'The Unlayer API returned an error; retry later.',
};

export function withDefaultHint(code: ErrorCode, hint?: string): ErrorInfo {
  const resolved = hint ?? DEFAULT_HINTS[code];
  return resolved ? { code, hint: resolved } : { code };
}

/** Map an error thrown by the SDK (or Node) to a code. */
export function classifyError(err: unknown): ErrorInfo {
  if (err instanceof Unlayer.APIConnectionError) return withDefaultHint('NETWORK');
  if (err instanceof Unlayer.APIError) {
    const status = err.status;
    if (status === 401 || status === 403) return withDefaultHint('AUTH_REQUIRED');
    if (status === 404) return withDefaultHint('NOT_FOUND');
    if (status === 400 || status === 422) return withDefaultHint('INVALID_INPUT');
    if (status === 429) return withDefaultHint('RATE_LIMITED');
    if (typeof status === 'number' && status >= 500) return withDefaultHint('SERVER_ERROR');
  }
  return { code: 'UNKNOWN' };
}

/**
 * Fallback for messages that were written by hand rather than thrown by the SDK.
 * Order matters: the first match wins.
 */
const MESSAGE_PATTERNS: Array<[RegExp, ErrorCode]> = [
  [/not authenticated|no authentication token|invalid token/i, 'AUTH_REQUIRED'],
  [/^non-interactive mode|^invalid |^missing |must be a number/i, 'INVALID_INPUT'],
  [/not found|^no .+ found|no environments defined/i, 'NOT_FOUND'],
  [/not reachable|econnrefused|enotfound|timed out/i, 'NETWORK'],
];

export function classifyMessage(message: string): ErrorInfo {
  for (const [pattern, code] of MESSAGE_PATTERNS) {
    if (pattern.test(message)) return withDefaultHint(code);
  }
  return { code: 'UNKNOWN' };
}

// Commands keep errors as plain strings in React state. Remember what an
// original Error was classified as so `jsonError(message)` can recover it.
const registry = new Map<string, ErrorInfo>();

/**
 * Get the message for an error and remember its classification.
 * Drop-in for `err instanceof Error ? err.message : fallback`; `prefix` is
 * prepended to the returned message when the caller wraps it.
 */
export function errorMessage(err: unknown, fallback: string, prefix = ''): string {
  const message = prefix + (err instanceof Error ? err.message : fallback);
  const info = classifyError(err);
  if (info.code !== 'UNKNOWN') registry.set(message, info);
  return message;
}

/** Resolve code/hint for a message: explicit > remembered > pattern > UNKNOWN. */
export function resolveErrorInfo(message: string, explicit?: Partial<ErrorInfo>): ErrorInfo {
  if (explicit?.code) return withDefaultHint(explicit.code, explicit.hint);
  const base = registry.get(message) ?? classifyMessage(message);
  return explicit?.hint ? { ...base, hint: explicit.hint } : base;
}

export function formatJsonError(message: string, explicit?: Partial<ErrorInfo>): string {
  const { code, hint } = resolveErrorInfo(message, explicit);
  return JSON.stringify(hint ? { error: message, code, hint } : { error: message, code });
}
