/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Docker HEALTHCHECK is a one-line script that cannot import the server's
 * code, so it repeats the port rule of src/config/env.ts. This runs the script
 * from the Dockerfile against readEnv on the same environments, so the two
 * cannot drift apart without a failing test.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readEnv } from '../src/config/env.js';

// Line endings normalized: a Windows checkout (git autocrlf) has CRLF.
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** The `node -e` script of the HEALTHCHECK instruction. */
function probeScript(): string {
  const match = /HEALTHCHECK[^\n]*\\\n\s*CMD (\[.*\])\n/.exec(dockerfile);
  if (!match) throw new Error('No HEALTHCHECK CMD in the Dockerfile');
  const cmd = JSON.parse(match[1] as string) as string[];
  expect(cmd.slice(0, 2)).toEqual(['node', '-e']);
  return cmd[2] as string;
}

/** The URL the probe fetches in the given environment. */
function probedUrl(env: Record<string, string>): string {
  let url = '';
  const fetch = (u: string): Promise<never> => {
    url = u;
    return new Promise<never>(() => {}); // never settles: the probe never exits
  };
  new Function('process', 'fetch', probeScript())({ env, exit: () => {} }, fetch);
  return url;
}

describe('Dockerfile HEALTHCHECK', () => {
  it('probes /health on the port the server listens on, for every way the port can be set', () => {
    const cases: Record<string, string>[] = [
      {},
      { PORT: '8080' },
      { MCP_HTTP_PORT: '4000' },
      { MCP_HTTP_PORT: '4000', PORT: '8080' },
      { MCP_HTTP_PORT: '', PORT: '8080' },
      { MCP_HTTP_PORT: '   ', PORT: '8080' },
      { MCP_HTTP_PORT: 'abc', PORT: '8080' },
      { MCP_HTTP_PORT: '70000', PORT: '8080' },
      { MCP_HTTP_PORT: '0', PORT: '8080' },
      { MCP_HTTP_PORT: ' 4000 ' },
      { MCP_HTTP_PORT: '40.5' },
      { PORT: 'abc' },
      { PORT: '' },
      { PORT: '65535' },
    ];
    for (const env of cases) {
      expect(probedUrl(env), JSON.stringify(env)).toBe(`http://127.0.0.1:${readEnv(env).http.port}/health`);
    }
  });
});
