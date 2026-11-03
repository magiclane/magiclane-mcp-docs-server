#!/usr/bin/env node
/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cross-platform launcher for the MCP Inspector against the HTTP transport.
 *
 * The docs server needs no credentials — the documentation it serves is
 * public — so the Inspector connects straight to the HTTP endpoint.
 *
 * Modes:
 *   (default) UI mode  - opens the browser UI.
 *   --cli              - CLI mode. Append e.g. `--method tools/list` or
 *                        `--method tools/call ...`.
 *
 * The Inspector is pinned to 1.0.2, the last release that runs on Node 22.18:
 * 2.x (and its undici 8 dependency) require Node >= 22.19. Move to @latest
 * once every development machine runs Node 22.19 or newer.
 *
 * The Inspector connects as soon as its page opens, so this waits until the
 * server accepts connections first: under `concurrently` both start at once,
 * and the server (a build, or tsx resolving) is often seconds behind — the
 * Inspector would otherwise report ECONNREFUSED and need a second Connect.
 *
 * Optional env overrides:
 *   MCP_HTTP_URL   full MCP endpoint URL (default http://127.0.0.1:3000/mcp)
 *   MCP_HTTP_WAIT_MS  how long to wait for the server (default 60000)
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';

const url = process.env.MCP_HTTP_URL ?? 'http://127.0.0.1:3000/mcp';
const waitMs = Number(process.env.MCP_HTTP_WAIT_MS ?? 60_000);

/** Resolves once something accepts a TCP connection at the URL's host and port; rejects after `timeoutMs`. */
function waitForServer(target, timeoutMs) {
  const { hostname, port, protocol } = new URL(target);
  const portNumber = Number(port || (protocol === 'https:' ? 443 : 80));
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect({ host: hostname, port: portNumber });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`nothing listens at ${hostname}:${portNumber}`));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

console.log(`[inspect:http] waiting for the server at ${url} (up to ${waitMs / 1000} s)…`);
try {
  await waitForServer(url, waitMs);
} catch (err) {
  console.error(
    `[inspect:http] ${err.message} after ${waitMs / 1000} s: is the HTTP server running on that address? ` +
      '(MCP_HTTP_URL names where the Inspector connects; the server listens on MCP_HTTP_HOST:MCP_HTTP_PORT, ' +
      'default 127.0.0.1:3000.)'
  );
  process.exit(1);
}
console.log('[inspect:http] the server is up: launching the Inspector.');
const extra = process.argv.slice(2);
const isCli = extra.includes('--cli');

const inspector = ['-y', '@modelcontextprotocol/inspector@1.0.2'];
const args = isCli
  ? [...inspector, '--cli', url, '--transport', 'http', ...extra.filter((a) => a !== '--cli')]
  : [...inspector, '--transport', 'http', '--server-url', url, ...extra];

// No shell: the URL and the arguments are passed as they are, so a value with
// a space, "&" or ";" is one argument, never a command. Under `npm run`, npx
// is npm's own npx-cli.js, run with this Node (Windows refuses to spawn
// npx.cmd without a shell).
const npxCli = process.env.npm_execpath ? join(dirname(process.env.npm_execpath), 'npx-cli.js') : undefined;
const [command, prefix] =
  npxCli && existsSync(npxCli) ? [process.execPath, [npxCli]] : [process.platform === 'win32' ? 'npx.cmd' : 'npx', []];

const child = spawn(command, [...prefix, ...args], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error(
    `[inspect:http] Failed to launch inspector: ${err.message}` +
      (process.platform === 'win32' ? ' (run it through npm: npm run inspect:build:http)' : '')
  );
  process.exit(1);
});
