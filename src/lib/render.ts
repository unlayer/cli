/**
 * Ink render wrapper for stdout/stderr separation.
 *
 * When quiet or JSON mode is active, all Ink decoration
 * (header, spinners, status messages) is redirected to stderr
 * so that stdout remains clean for machine-readable output.
 *
 * Commands use `renderCommand()` as a drop-in replacement for
 * Ink's `render()`.
 */

import { render, type Instance } from 'ink';
import type { ReactElement } from 'react';
import * as fs from 'fs';
import { isQuiet, isJsonMode } from './cli-flags.js';
import { EXIT_USAGE_ERROR } from './exit-codes.js';
import { verboseLog } from './verbose.js';
import { formatJsonError, type ErrorInfo } from './errors.js';

export function renderCommand(element: ReactElement): Instance {
  const shouldRedirect = isQuiet() || isJsonMode();
  verboseLog(`Rendering command (redirect=${shouldRedirect})`);

  return render(element, shouldRedirect ? { stdout: process.stderr } : undefined);
}

/**
 * Write data directly to real stdout (fd 1), bypassing Ink's
 * console.log interception. Use this for all machine-readable
 * output (JSON data) inside Ink components.
 *
 * Ink intercepts console.log and routes it through its own
 * stdout stream. When we redirect Ink to stderr for clean
 * JSON mode, console.log also goes to stderr. This function
 * writes directly to the file descriptor, guaranteeing stdout.
 */
export function stdoutWrite(data: string): void {
  fs.writeSync(1, data + '\n');
}

/**
 * Write a structured JSON error to stderr:
 * `{"error": message, "code": ..., "hint"?: ...}`.
 * Call this from error-exit effects when JSON mode is active
 * so agents can parse failures programmatically. `code` and `hint`
 * are inferred when not given (see lib/errors.ts).
 */
export function jsonError(message: string, info?: Partial<ErrorInfo>): void {
  if (isJsonMode()) {
    process.stderr.write(formatJsonError(message, info) + '\n');
  }
}

/**
 * Mark the current process as a usage error (exit code 2).
 * Call this before `exit(new Error(...))` for input/validation errors
 * (missing args, bad flags, non-interactive guard failures).
 */
export function setUsageError(): void {
  process.exitCode = EXIT_USAGE_ERROR;
}
