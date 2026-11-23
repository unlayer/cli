/**
 * Unit tests for src/lib/errors.ts and the jsonError() output contract.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import Unlayer from '@unlayer/sdk';
import {
  classifyError,
  classifyMessage,
  errorMessage,
  formatJsonError,
  resolveErrorInfo,
} from '../errors.js';

function apiError(status: number, message = 'boom') {
  return Unlayer.APIError.generate(status, { message }, message, new Headers());
}

describe('classifyError', () => {
  it.each([
    [401, 'AUTH_REQUIRED'],
    [403, 'AUTH_REQUIRED'],
    [404, 'NOT_FOUND'],
    [400, 'INVALID_INPUT'],
    [422, 'INVALID_INPUT'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVER_ERROR'],
    [503, 'SERVER_ERROR'],
  ])('maps HTTP %i to %s', (status, code) => {
    expect(classifyError(apiError(status)).code).toBe(code);
  });

  it('maps connection failures to NETWORK', () => {
    const err = new Unlayer.APIConnectionError({ message: 'down' });
    expect(classifyError(err).code).toBe('NETWORK');
  });

  it('maps timeouts to NETWORK', () => {
    expect(classifyError(new Unlayer.APIConnectionTimeoutError()).code).toBe('NETWORK');
  });

  it('falls back to UNKNOWN for other errors', () => {
    expect(classifyError(new Error('x'))).toEqual({ code: 'UNKNOWN' });
    expect(classifyError('nope')).toEqual({ code: 'UNKNOWN' });
  });

  it('includes a hint for known codes', () => {
    expect(classifyError(apiError(401)).hint).toContain('unlayer login');
  });
});

describe('classifyMessage', () => {
  it.each([
    ['Not authenticated', 'AUTH_REQUIRED'],
    ['Invalid token. Please check your token and try again.', 'AUTH_REQUIRED'],
    ['Non-interactive mode: provide a template-id argument.', 'INVALID_INPUT'],
    ['Invalid workspace ID. Must be a number.', 'INVALID_INPUT'],
    ['Invalid template: foo. Use: a, b', 'INVALID_INPUT'],
    ['No templates found.', 'NOT_FOUND'],
    ['Environment "staging" not found', 'NOT_FOUND'],
    ['API not reachable', 'NETWORK'],
  ])('%s -> %s', (message, code) => {
    expect(classifyMessage(message).code).toBe(code);
  });

  it('returns UNKNOWN for unrecognised messages', () => {
    expect(classifyMessage('Something odd happened')).toEqual({ code: 'UNKNOWN' });
  });
});

describe('errorMessage', () => {
  it('returns the original message unchanged', () => {
    expect(errorMessage(new Error('hello'), 'fallback')).toBe('hello');
  });

  it('uses the fallback for non-Error values', () => {
    expect(errorMessage('oops', 'fallback')).toBe('fallback');
  });

  it('remembers the classification of the original error', () => {
    const message = errorMessage(apiError(404, 'Template 9 missing'), 'fallback');
    expect(resolveErrorInfo(message).code).toBe('NOT_FOUND');
  });

  it('applies a prefix and still remembers the classification', () => {
    const err = apiError(401, 'bad token');
    const message = errorMessage(err, 'fallback', 'Failed to connect: ');
    expect(message).toBe('Failed to connect: ' + err.message);
    expect(resolveErrorInfo(message).code).toBe('AUTH_REQUIRED');
  });
});

describe('formatJsonError', () => {
  it('keeps the error field and adds code and hint', () => {
    const out = JSON.parse(formatJsonError('No templates found.'));
    expect(out).toEqual({
      error: 'No templates found.',
      code: 'NOT_FOUND',
      hint: expect.any(String),
    });
  });

  it('always includes a code, omitting hint when there is none', () => {
    expect(JSON.parse(formatJsonError('Something odd happened'))).toEqual({
      error: 'Something odd happened',
      code: 'UNKNOWN',
    });
  });

  it('prefers an explicit code and hint', () => {
    const out = JSON.parse(
      formatJsonError('No templates found.', { code: 'INVALID_INPUT', hint: 'Try again' }),
    );
    expect(out).toEqual({ error: 'No templates found.', code: 'INVALID_INPUT', hint: 'Try again' });
  });
});

describe('jsonError', () => {
  let write: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    write.mockRestore();
  });

  async function load(json: boolean) {
    const flags = await import('../cli-flags.js');
    flags.initGlobalFlags({ json });
    return import('../render.js');
  }

  it('writes {error, code, hint} to stderr in JSON mode', async () => {
    const { jsonError } = await load(true);
    jsonError('Not authenticated');
    const line = String(write.mock.calls[0][0]);
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toMatchObject({ error: 'Not authenticated', code: 'AUTH_REQUIRED' });
  });

  it('writes nothing outside JSON mode', async () => {
    const { jsonError } = await load(false);
    jsonError('Not authenticated');
    expect(write).not.toHaveBeenCalled();
  });
});
