/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * VERBOSE is read from the environment at module load, so these tests use
 * `vi.resetModules()` + dynamic imports to exercise both states.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBooleanEnv } from '../../src/config/env.js';

async function loadLogger(verbose: string | undefined) {
  vi.resetModules();
  if (verbose === undefined) {
    delete process.env.VERBOSE;
  } else {
    process.env.VERBOSE = verbose;
  }
  return import('../../src/utils/logger.js');
}

describe('parseBooleanEnv', () => {
  it('treats unset and empty values as false', () => {
    expect(parseBooleanEnv(undefined)).toBe(false);
    expect(parseBooleanEnv('')).toBe(false);
  });

  it('accepts the documented truthy spellings, case- and space-insensitively', () => {
    for (const value of ['true', 'TRUE', ' True ', '1', 'yes', 'YES', 'on']) {
      expect(parseBooleanEnv(value)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    for (const value of ['false', '0', 'no', 'off', 'verbose', 'maybe']) {
      expect(parseBooleanEnv(value)).toBe(false);
    }
  });
});

describe('logger with VERBOSE unset (default)', () => {
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    stderr.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports verbose as disabled', async () => {
    const { isVerbose } = await loadLogger(undefined);
    expect(isVerbose()).toBe(false);
  });

  it('logs nothing', async () => {
    const { logVerbose, logToolInvocation } = await loadLogger(undefined);
    logVerbose('should not appear');
    logToolInvocation('search_docs');
    expect(stderr).not.toHaveBeenCalled();
  });

  it('logs nothing for explicitly false values', async () => {
    const { logToolInvocation } = await loadLogger('false');
    logToolInvocation('read_doc');
    expect(stderr).not.toHaveBeenCalled();
  });
});

describe('logger with VERBOSE=true', () => {
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    stderr.mockClear();
  });

  afterEach(() => {
    delete process.env.VERBOSE;
  });

  it('reports verbose as enabled', async () => {
    const { isVerbose } = await loadLogger('true');
    expect(isVerbose()).toBe(true);
  });

  it('writes prefixed diagnostics to stderr, never stdout', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { logVerbose } = await loadLogger('true');
    logVerbose('hello');
    expect(stderr).toHaveBeenCalledWith('[Magic Lane MCP Docs] hello');
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();
  });

  it('logs tool invocations with the tool name', async () => {
    const { logToolInvocation } = await loadLogger('true');
    logToolInvocation('find_across_sdks');
    expect(stderr).toHaveBeenCalledWith('[Magic Lane MCP Docs] tool invoked: find_across_sdks');
  });
});
