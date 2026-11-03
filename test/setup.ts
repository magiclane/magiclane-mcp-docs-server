/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The suite must not depend on the shell it runs in, nor on the network.
 *
 * `src/config/env.ts` reads `process.env` once at import time, so a developer
 * who has exported MCP_HTTP_PATH or VERBOSE would get different behaviour —
 * and different coverage — from a colleague for the same commit. Clearing the server's
 * variables here (vitest runs setup files before any test module is imported)
 * makes every run start from the documented defaults.
 *
 * Unit tests seed the memos and the page cache instead of fetching, so a real
 * network request from a unit test is a bug: `fetch` is replaced with a guard
 * that fails loudly. Tests that exercise the HTTP client stub `fetch` on top.
 * The live-site integration test opts out of the guard explicitly.
 */

/** Every variable `readEnv()` looks at, including the spawned server's. */
const SERVER_ENV_VARS = [
  'VERBOSE',
  'PORT',
  'MCP_HTTP_PORT',
  'MCP_HTTP_HOST',
  'MCP_HTTP_PATH',
  'MCP_CORS_ORIGIN',
  'MCP_ALLOWED_HOSTS',
  'MCP_DNS_REBINDING_PROTECTION',
  'MCP_TRUSTED_PROXIES',
  'TRUSTED_PROXY_HOPS',
];

for (const name of SERVER_ENV_VARS) delete process.env[name];

/** Node's real fetch, for the one suite that talks to its own loopback server. */
(globalThis as { __realFetch?: typeof fetch }).__realFetch = globalThis.fetch;

if (!process.env.LIVE_DOCS_TESTS) {
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    throw new Error(`Unit tests must not reach the network (attempted fetch of ${url}); seed a fixture or stub fetch.`);
  }) as typeof fetch;
}
