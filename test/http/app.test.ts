/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The HTTP application over a REAL `node:http` server on an ephemeral port, so
 * every status the transport layer can answer — 204, 400, 403, 404, 405, 408,
 * 413, 429, 500, 503 — is exercised the way a client would trigger it. Limits
 * and the clock are injected, so rate windows, body budgets and timeouts are
 * tested in milliseconds rather than minutes.
 */
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHttpApp, pathOf, reloadOrder } from '../../src/http/app.js';
import type { HttpApp, HttpAppOptions, HttpLimits, UpstreamFailure } from '../../src/http/app.js';
import { createServer } from '../../src/server.js';
import { buildAllowedHosts, parseCorsPolicy, parseTrustedProxies } from '../../src/utils/http-security.js';
import { SERVER_NAME, SERVER_VERSION } from '../../src/version.js';
import {
  FLUTTER_FULL,
  FLUTTER_LLMS,
  resetCaches,
  sdkIndexFixture,
  seedFixtures,
  stubFetch,
  textOf,
} from '../helpers.js';
import { failingIndexes, loadIndex, seedIndex } from '../../src/docs/docs-index.js';
import { failingFullTexts, loadFullTextSections, seedFullTextSections } from '../../src/docs/full-text.js';
import { fetchQueueStats, fetchText } from '../../src/utils/http-client.js';
import { withRequestContext } from '../../src/utils/request-context.js';
import { DOCS, FETCH } from '../../src/config/constants.js';

const MCP_PATH = '/mcp';
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};
const TOOLS_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
/** A call that needs a concurrency slot (unlike initialize, ping and the list methods). */
const LIST_DOCS = {
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'list_docs', arguments: { source: 'flutter' } },
};

/**
 * vi.waitFor with room for a loaded machine: its default gives up after 1 s,
 * which a request on a busy test host can take just to reach the queue. (The
 * occasional "0 queued, expected 1" failure had another cause: unreferenced
 * responses, see `keep`.) A passing wait still returns as soon as the state
 * is reached.
 */
const waitFor = <T>(check: () => T | Promise<T>): Promise<T> => vi.waitFor(check, { timeout: 15_000, interval: 10 });

/** Test-sized limits: generous unless a test narrows one. */
function limits(overrides: Partial<HttpLimits> = {}): HttpLimits {
  return {
    maxBodyBytes: 4096,
    maxInFlightBodyBytes: 1 << 20,
    maxInFlightBodyBytesPerClient: 1 << 20,
    bodyTimeoutMs: 5000,
    maxConcurrentRequests: 8,
    maxConcurrentPerClient: 8,
    maxQueuedRequests: 8,
    queueWaitMs: 5000,
    rateLimitMax: 1000,
    rateLimitWindowMs: 60_000,
    toolCallCosts: {},
    ...overrides,
  };
}

interface Running {
  app: HttpApp;
  base: string;
  port: number;
  stop: () => Promise<void>;
}

/** Start the app on an ephemeral loopback port with production-like defaults, overridable per test. */
async function start(overrides: Partial<HttpAppOptions> = {}): Promise<Running> {
  const app = createHttpApp({
    mcpPath: MCP_PATH,
    allowedHosts: buildAllowedHosts('127.0.0.1', 0, []),
    dnsRebindingProtection: true,
    corsPolicy: parseCorsPolicy(''),
    trustedProxyHops: 0,
    trustedProxies: [],
    limits: limits(),
    createServer,
    // Memos are shared across tests; an injected empty list keeps one test's
    // failed download out of the next one's /health (see the upstream tests).
    upstreamFailures: () => [],
    // One index loaded: past "starting" — but none in memory for the slot
    // bypass, so list_docs needs a slot like any tool call (see the
    // IN_MEMORY_TOOLS tests for the other case).
    indexesLoaded: () => 1,
    indexLoaded: () => false,
    fullTextLoaded: () => false,
    loadIndexes: () => {},
    reloadFailing: () => {},
    ...overrides,
  });
  const server: Server = createHttpServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    app,
    port,
    base: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A raw request for cases fetch() cannot express: a forged Host header, odd targets. */
function raw(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; body: string; headers: IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode as number, body, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/** Open a socket, send `head` (and optional partial body) and leave it open. */
function openSocket(port: number, head: string): Promise<{ socket: Socket; response: () => Promise<string> }> {
  return new Promise((resolve) => {
    const socket = netConnect(port, '127.0.0.1', () => {
      socket.write(head);
      let data = '';
      socket.on('data', (c: Buffer) => (data += c.toString()));
      const response = (): Promise<string> =>
        new Promise((done) => {
          const check = (): void => {
            if (/\r\n\r\n/.test(data) && /"id":null\}(\r\n0\r\n\r\n)?\s*$/.test(data)) done(data);
            else setTimeout(check, 10);
          };
          check();
        });
      resolve({ socket, response });
    });
  });
}

const post = (
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal
): Promise<Response> =>
  fetch(`${base}${MCP_PATH}`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(body),
    signal,
  });

/**
 * Requests a test sends without awaiting. Their responses are kept here until
 * the test ends: a response nobody references can be garbage-collected, and
 * the HTTP client then closes its connection — the server sees a client that
 * went away and frees its slot, which made the slot tests fail at random.
 */
let held: Array<Promise<unknown>> = [];
const keep = (request: Promise<unknown>): void => {
  held.push(request.catch(() => {}));
};

/** A read_doc call for a page that is not cached, so it needs the documentation host. */
const readDoc = (page: string, id = 9): unknown => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'read_doc', arguments: { url: `/docs/flutter/hang/${page}` } },
});

/** Requests from distinct clients, told apart by a trusted proxy's X-Forwarded-For. */
const as = (ip: string): Record<string, string> => ({ 'x-forwarded-for': ip });
const VIA_PROXY = { trustedProxyHops: 1, trustedProxies: parseTrustedProxies(['127.0.0.1']) };

/**
 * Route loopback requests to Node's fetch and hold every request to the
 * documentation host until `fail()` (or until the fetch is aborted).
 */
function hangingUpstream(realFetch: typeof fetch): { fail: () => void; aborted: () => number } {
  const pending: Array<(err: Error) => void> = [];
  let failing = false;
  let aborted = 0;
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    if (input.startsWith('http://127.0.0.1')) return realFetch(input, init);
    if (failing) return Promise.reject(new Error('upstream down'));
    return new Promise((_resolve, reject) => {
      pending.push(reject);
      init?.signal?.addEventListener('abort', () => {
        aborted++;
        reject(init.signal?.reason);
      });
    });
  });
  return {
    fail: () => {
      failing = true;
      for (const reject of pending.splice(0)) reject(new Error('upstream down'));
    },
    aborted: () => aborted,
  };
}

describe('pathOf', () => {
  it('returns the path without parsing a URL, so hostile targets cannot throw', () => {
    expect(pathOf('/mcp?x=1#y')).toBe('/mcp');
    expect(pathOf('//[')).toBe('//[');
    expect(pathOf('')).toBe('/');
    expect(pathOf(undefined)).toBe('/');
    expect(pathOf('?only=query')).toBe('/');
  });
});

describe('createHttpApp', () => {
  let running: Running;
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const realFetch = (globalThis as { __realFetch?: typeof fetch }).__realFetch as typeof fetch;

  beforeEach(() => {
    seedFixtures();
    stderr.mockClear();
    // The hermetic guard in test/setup.ts replaces fetch; this file talks to
    // its own loopback server, so use Node's real implementation.
    vi.stubGlobal('fetch', realFetch);
  });

  afterEach(async () => {
    await running?.stop();
    vi.unstubAllGlobals();
    held = [];
  });

  describe('request validation', () => {
    it('answers OPTIONS preflight with 204 and the CORS method list', async () => {
      running = await start();
      const res = await fetch(`${running.base}/health`, { method: 'OPTIONS' });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    });

    it('marks every response no-store and nosniff', async () => {
      running = await start();
      for (const path of ['/health', '/nowhere']) {
        const res = await fetch(`${running.base}${path}`);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      }
    });

    it('rejects a Host header that is not allowlisted, naming it', async () => {
      running = await start();
      const res = await raw(running.port, '/health', { headers: { Host: 'evil.example' } });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error.message).toContain('"evil.example"');
      expect(JSON.parse(res.body).error.message).toContain('MCP_ALLOWED_HOSTS');
    });

    it('accepts loopback on a port other than the listen port (published container ports)', async () => {
      running = await start();
      expect((await raw(running.port, '/health', { headers: { Host: 'localhost:8080' } })).status).toBe(200);
    });

    it('does not throw on a malformed Host or a malformed request target', async () => {
      running = await start({ dnsRebindingProtection: false });
      expect((await raw(running.port, '/health', { headers: { Host: 'bad host with spaces' } })).status).toBe(200);
      const odd = await raw(running.port, '//[');
      expect(odd.status).toBe(404);
      expect(JSON.parse(odd.body).error).toContain('MCP endpoint is /mcp');
    });

    it('refuses a browser origin that is not allowlisted', async () => {
      running = await start();
      const res = await fetch(`${running.base}/health`, { headers: { origin: 'https://evil.example' } });
      expect(res.status).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('echoes an allowlisted origin and varies on it; sends a wildcard without Vary', async () => {
      running = await start({ corsPolicy: parseCorsPolicy('https://ok.example') });
      const res = await fetch(`${running.base}/health`, { headers: { origin: 'https://ok.example' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('https://ok.example');
      expect(res.headers.get('vary')).toBe('Origin');
      await running.stop();
      running = await start({ corsPolicy: parseCorsPolicy('*') });
      const any = await fetch(`${running.base}/health`, { headers: { origin: 'https://anything.example' } });
      expect(any.headers.get('access-control-allow-origin')).toBe('*');
      expect(any.headers.get('vary')).toBeNull();
    });

    it('returns 404 for unknown paths, naming the endpoint only when it is the default', async () => {
      running = await start();
      const res = await fetch(`${running.base}/docs-mcp`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found. MCP endpoint is /mcp' });
      await running.stop();
      running = await start({ mcpPath: '/k7Qx9/mcp' });
      const hidden = await fetch(`${running.base}/`);
      expect(hidden.status).toBe(404);
      expect(await hidden.json()).toEqual({ error: 'Not found' });
    });

    it('answers 400 and closes the connection when routing itself throws', () => {
      const app = createHttpApp({
        mcpPath: MCP_PATH,
        allowedHosts: new Set(),
        dnsRebindingProtection: false,
        corsPolicy: parseCorsPolicy(''),
        trustedProxyHops: 0,
        trustedProxies: [],
        limits: limits({ maxBodyBytes: 1, rateLimitMax: 1, rateLimitWindowMs: 1 }),
        createServer,
      });
      const written: unknown[] = [];
      let setHeaderCalls = 0;
      const res = {
        headersSent: false,
        setHeader: () => {
          if (++setHeaderCalls > 2) throw new Error('boom');
        },
        writeHead: (status: number, headers: unknown) => {
          written.push(status, headers);
          return res;
        },
        end: () => written.push('end'),
      } as unknown as ServerResponse;
      app.handler({ method: 'GET', url: '/health', headers: {}, socket: {} } as unknown as IncomingMessage, res);
      expect(written[0]).toBe(400);
      expect(written[1]).toMatchObject({ Connection: 'close' });
      expect(stderr).toHaveBeenCalledWith('Error routing request:', expect.any(Error));

      // When headers already went out, the response is just ended.
      written.length = 0;
      setHeaderCalls = 0;
      (res as unknown as { headersSent: boolean }).headersSent = true;
      app.handler({ method: 'GET', url: '/health', headers: {}, socket: {} } as unknown as IncomingMessage, res);
      expect(written).toEqual(['end']);
    });
  });

  describe('rate limiting', () => {
    it('answers 429 with Retry-After past the per-client budget and resets after the window', async () => {
      let now = 1_000_000;
      running = await start({
        now: () => now,
        limits: limits({ rateLimitMax: 2, rateLimitWindowMs: 1000 }),
      });
      expect((await fetch(`${running.base}/health`)).status).toBe(200);
      expect((await fetch(`${running.base}/health`)).status).toBe(200);
      const limited = await fetch(`${running.base}/health`);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('1');
      expect((await limited.json()).error.message).toBe('Rate limit exceeded (2 requests per 1s)');
      now += 400;
      // Retry-After is what is left of the window, never less than a second.
      expect((await fetch(`${running.base}/health`)).headers.get('retry-after')).toBe('1');
      now += 601;
      expect((await fetch(`${running.base}/health`)).status).toBe(200);
      running.app.sweep(); // the live window stays
      expect(running.app.stats().rateBuckets).toBe(1);
      now += 1001;
      running.app.sweep();
      expect(running.app.stats().rateBuckets).toBe(0);
    });

    it('does not lock a client out for as long as a backward clock step', async () => {
      let now = 10_000_000;
      running = await start({ now: () => now, limits: limits({ rateLimitMax: 1, rateLimitWindowMs: 1000 }) });
      expect((await fetch(`${running.base}/health`)).status).toBe(200);
      expect((await fetch(`${running.base}/health`)).status).toBe(429);
      // The wall clock steps back an hour: the window opened before the step is over, not an hour longer.
      now -= 3_600_000;
      expect((await fetch(`${running.base}/health`)).status).toBe(200);
      expect((await fetch(`${running.base}/health`)).status).toBe(429);
      now -= 3_600_000;
      running.app.sweep(); // a window from the future is swept too
      expect(running.app.stats().rateBuckets).toBe(0);
    });

    it('counts /health and /ready in a window of their own, so probes and MCP traffic do not starve each other', async () => {
      running = await start({ limits: limits({ rateLimitMax: 2, rateLimitWindowMs: 60_000 }) });
      expect((await post(running.base, TOOLS_LIST)).status).toBe(200);
      expect((await post(running.base, TOOLS_LIST)).status).toBe(200);
      expect((await post(running.base, TOOLS_LIST)).status).toBe(429);
      expect((await fetch(`${running.base}/health`)).status).toBe(200);
      expect((await fetch(`${running.base}/ready`)).status).toBe(200);
      expect((await fetch(`${running.base}/health`)).status).toBe(429);
      expect(running.app.stats().rateBuckets).toBe(2);
    });

    it('caps the rate-limit table: the oldest window makes room for a new client, after a sweep', async () => {
      let now = 1_000_000;
      running = await start({
        ...VIA_PROXY,
        now: () => now,
        limits: limits({ rateLimitMax: 2, rateLimitWindowMs: 1000, maxRateBuckets: 2 }),
      });
      const health = (ip: string): Promise<number> =>
        fetch(`${running.base}/health`, { headers: as(ip) }).then((r) => r.status);
      expect(await health('10.0.0.1')).toBe(200);
      now += 10;
      expect(await health('10.0.0.2')).toBe(200);
      expect(await health('10.0.0.2')).toBe(200);
      expect(await health('10.0.0.2')).toBe(429);
      // Full: .1 (the oldest window) is evicted for .3; .2 keeps its window.
      expect(await health('10.0.0.3')).toBe(200);
      expect(running.app.stats().rateBuckets).toBe(2);
      expect(await health('10.0.0.2')).toBe(429);
      // .1 comes back as a new client with a fresh window, evicting .2 — the oldest now.
      expect(await health('10.0.0.1')).toBe(200);
      expect(await health('10.0.0.2')).toBe(200);
      expect(running.app.stats().rateBuckets).toBe(2);
      // A zone suffix of any length is the same address, not a new key.
      expect(await health(`fe80::1%${'z'.repeat(5000)}`)).toBe(200);
      expect(await health('fe80::1')).toBe(200);
      expect(await health('fe80::1')).toBe(429);
      expect(running.app.stats().rateBuckets).toBe(2);
      // Within a second of the last sweep, a full table evicts without sweeping;
      // after that, the sweep drops expired windows and nothing is evicted.
      now += 1001;
      expect(await health('10.0.0.6')).toBe(200);
      expect(running.app.stats().rateBuckets).toBe(1);
      // A backward clock step does not hold the sweep off for the length of
      // the step: the last sweep's reading lies in the future, so a full table
      // sweeps (and drops the windows from before the step) instead of evicting.
      expect(await health('10.0.0.7')).toBe(200);
      expect(running.app.stats().rateBuckets).toBe(2);
      now -= 3_600_000;
      expect(await health('10.0.0.8')).toBe(200);
      expect(running.app.stats().rateBuckets).toBe(1);
    });

    it('keys by X-Forwarded-For only when the peer is a trusted proxy', async () => {
      running = await start({
        trustedProxyHops: 1,
        trustedProxies: parseTrustedProxies(['127.0.0.1']),
        limits: limits({ rateLimitMax: 1 }),
      });
      expect((await fetch(`${running.base}/health`, { headers: { 'x-forwarded-for': '1.1.1.1' } })).status).toBe(200);
      expect((await fetch(`${running.base}/health`, { headers: { 'x-forwarded-for': '2.2.2.2' } })).status).toBe(200);
      expect((await fetch(`${running.base}/health`, { headers: { 'x-forwarded-for': '2.2.2.2' } })).status).toBe(429);
      await running.stop();
      // Not trusted: the header is ignored and every request shares the socket's bucket.
      running = await start({
        trustedProxyHops: 1,
        trustedProxies: [],
        limits: limits({ rateLimitMax: 1 }),
      });
      expect((await fetch(`${running.base}/health`, { headers: { 'x-forwarded-for': '1.1.1.1' } })).status).toBe(200);
      expect((await fetch(`${running.base}/health`, { headers: { 'x-forwarded-for': '2.2.2.2' } })).status).toBe(429);
    });
  });

  describe('/health', () => {
    it('reports the package identity, in-flight work and cache statistics', async () => {
      running = await start();
      const res = await fetch(`${running.base}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: 'ok',
        server: SERVER_NAME,
        version: SERVER_VERSION,
        inFlightRequests: 0,
        queuedRequests: 0,
        maxConcurrentRequests: 8,
        inFlightBodyBytes: 0,
        outbound: { active: 0, queued: 0, maxQueued: expect.any(Number) },
        upstream: { failing: [] },
        cache: { entries: expect.any(Number), bytes: expect.any(Number), failures: expect.any(Number) },
        fullText: { sources: expect.any(Number), sections: expect.any(Number) },
      });
    });

    it('answers GET and HEAD only, on /health and /ready alike', async () => {
      running = await start();
      for (const path of ['/health', '/ready']) {
        const res = await fetch(`${running.base}${path}`, { method: 'POST' });
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
        expect((await fetch(`${running.base}${path}`, { method: 'HEAD' })).status).toBe(200);
      }
    });

    it('reports documentation files it could not refresh as "degraded" — never a reason to restart', async () => {
      running = await start({
        indexesLoaded: () => 6,
        upstreamFailures: () => [
          { source: 'flutter', part: 'index', reason: 'HTTP 503', serving: 'stale copy' },
          { source: 'ios', part: 'full-text', reason: 'timeout', serving: 'nothing' },
        ],
      });
      for (const path of ['/health', '/ready']) {
        const res = await fetch(`${running.base}${path}`);
        expect(res.status, path).toBe(200);
        expect(await res.json()).toMatchObject({
          status: 'degraded',
          reasons: [
            'documentation files not refreshed from developer.magiclane.com: ' +
              'flutter index (serving stale copy), ios full-text (serving nothing)',
          ],
          upstream: {
            failing: [
              { source: 'flutter', part: 'index' },
              { source: 'ios', part: 'full-text' },
            ],
          },
        });
      }
    });

    it('is not ready ("starting") until an index has loaded, and starts that load', async () => {
      const loadIndexes = vi.fn();
      running = await start({ indexesLoaded: () => 0, loadIndexes });
      const ready = await fetch(`${running.base}/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({
        status: 'starting',
        reasons: ['no documentation index loaded yet: loading'],
      });
      expect((await fetch(`${running.base}/health`)).status).toBe(200);
      expect(loadIndexes).toHaveBeenCalledTimes(2);
    });

    it('is not ready ("unavailable") while no index is loaded and loading one fails, and keeps retrying', async () => {
      const loadIndexes = vi.fn();
      const failing = [{ source: 'developer', part: 'index' as const, reason: 'timeout', serving: 'nothing' as const }];
      running = await start({ indexesLoaded: () => 0, upstreamFailures: () => failing, loadIndexes });
      const ready = await fetch(`${running.base}/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({
        status: 'unavailable',
        reasons: [
          'no documentation index loaded: searches and listings cannot be answered',
          'documentation files not refreshed from developer.magiclane.com: developer index (serving nothing)',
        ],
      });
      // Alive all the same: a restart would not bring the documentation host back.
      expect((await fetch(`${running.base}/health`)).status).toBe(200);
      expect(loadIndexes).toHaveBeenCalledTimes(2);
      await running.stop();
      // Only page contents failing, with an index loaded: still ready.
      running = await start({
        upstreamFailures: () => [{ ...(failing[0] as UpstreamFailure), part: 'full-text' }],
        loadIndexes,
      });
      expect((await fetch(`${running.base}/ready`)).status).toBe(200);
      expect(loadIndexes).toHaveBeenCalledTimes(2);
    });

    it('reads the upstream state from the index and full-text memos by default', async () => {
      resetCaches();
      const { restore } = stubFetch({});
      try {
        await loadIndex(['flutter']);
        await loadFullTextSections(['ios'], { entries: [], failed: [] });
        running = await start({
          upstreamFailures: undefined,
          indexesLoaded: undefined,
          loadIndexes: undefined,
          reloadFailing: undefined,
        });
        const health = await (await realFetch(`${running.base}/health`)).json();
        expect(health.upstream.failing).toEqual([
          { source: 'flutter', part: 'index', reason: expect.stringContaining('404'), serving: 'nothing' },
          { source: 'ios', part: 'full-text', reason: expect.stringContaining('404'), serving: 'nothing' },
        ]);
        // No index loaded: not ready, and every index is being loaded again.
        expect(health.status).toBe('unavailable');
        await waitFor(() => expect(failingIndexes()).toHaveLength(DOCS.sources.length));
        // With an index in memory, only the failed files are tried again.
        seedIndex('android', FLUTTER_LLMS.replaceAll('/flutter/', '/android/'));
        const degraded = await (await realFetch(`${running.base}/health`)).json();
        expect(degraded.status).toBe('degraded');
        await waitFor(() => expect(failingFullTexts().map((f) => f.source)).toEqual(['ios']));
        // Only an index failing, then only page contents: each is tried again on its own.
        seedFullTextSections('ios', '## Docs\n\n### Get Started (ios)\n\nOverview.\n');
        const indexesOnly = (await (await realFetch(`${running.base}/health`)).json()).upstream.failing;
        expect(indexesOnly.length).toBeGreaterThan(0);
        expect(indexesOnly.every((f: UpstreamFailure) => f.part === 'index')).toBe(true);
        for (const s of DOCS.sources) seedIndex(s.id, sdkIndexFixture(s.id));
        await loadFullTextSections(['cpp'], { entries: [], failed: [] });
        expect((await (await realFetch(`${running.base}/health`)).json()).upstream.failing).toEqual([
          expect.objectContaining({ source: 'cpp', part: 'full-text' }),
        ]);
      } finally {
        restore();
        resetCaches();
      }
    });

    it('tries the failed files again when probed while one is failing, so an idle server recovers', async () => {
      const failing: UpstreamFailure[] = [
        { source: 'flutter', part: 'full-text', reason: 'HTTP 503', serving: 'nothing' },
        { source: 'ios', part: 'index', reason: 'HTTP 503', serving: 'stale copy' },
      ];
      const reloadFailing = vi.fn();
      running = await start({ upstreamFailures: () => failing, reloadFailing });
      expect((await (await fetch(`${running.base}/health`)).json()).status).toBe('degraded');
      expect((await fetch(`${running.base}/ready`)).status).toBe(200);
      expect(reloadFailing).toHaveBeenCalledTimes(2);
      expect(reloadFailing).toHaveBeenCalledWith(failing);
      // Nothing failing: nothing to try again.
      failing.length = 0;
      expect((await (await fetch(`${running.base}/health`)).json()).status).toBe('ok');
      expect(reloadFailing).toHaveBeenCalledTimes(2);
    });

    it('reports "degraded" (still 200) while every slot is busy, naming the reason', async () => {
      const upstream = hangingUpstream(realFetch);
      running = await start({ limits: limits({ maxConcurrentRequests: 1 }) });
      keep(post(running.base, readDoc('busy')));
      await waitFor(() => expect(running.app.stats()).toMatchObject({ inFlightRequests: 1, servingRequests: 1 }));
      const health = await fetch(`${running.base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: 'degraded', reasons: ['all request slots busy'] });
      expect((await fetch(`${running.base}/ready`)).status).toBe(200);
      upstream.fail();
      await waitFor(() => expect(running.app.stats()).toMatchObject({ inFlightRequests: 0, servingRequests: 0 }));
      expect((await (await fetch(`${running.base}/health`)).json()).status).toBe('ok');
    });

    it('reports "degraded" while the outbound fetch queue is full', async () => {
      hangingUpstream(realFetch);
      running = await start();
      const stop = new AbortController();
      const pending = Array.from({ length: FETCH.maxConcurrent + FETCH.maxQueued }, (_, i) =>
        withRequestContext({ signal: stop.signal, client: `c${i % 8}` }, () =>
          fetchText(`https://developer.magiclane.com/docs/flutter/q/${i}.md`)
        ).catch(() => {})
      );
      await waitFor(() => expect(fetchQueueStats().queued).toBe(FETCH.maxQueued));
      const health = await (await fetch(`${running.base}/health`)).json();
      expect(health).toMatchObject({ status: 'degraded', reasons: ['outbound fetch queue full'] });
      stop.abort();
      await Promise.all(pending);
      await waitFor(() => expect(fetchQueueStats()).toMatchObject({ active: 0, queued: 0 }));
    });

    it('reports "degraded" while a page fetch has been running over 5 s', async () => {
      const upstream = hangingUpstream(realFetch);
      running = await start();
      keep(post(running.base, readDoc('hangs')));
      await waitFor(() => expect(fetchQueueStats().active).toBe(1));
      expect((await (await fetch(`${running.base}/health`)).json()).status).toBe('ok');
      const realNow = Date.now.bind(Date);
      const later = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + FETCH.slowFetchMs + 1);
      try {
        const health = await (await fetch(`${running.base}/health`)).json();
        expect(health).toMatchObject({ status: 'degraded' });
        expect(health.reasons).toEqual([expect.stringContaining('developer.magiclane.com is hanging')]);
      } finally {
        later.mockRestore();
        upstream.fail();
      }
      await waitFor(() => expect(fetchQueueStats().active).toBe(0));
    });

    it('turns 503 once the app is closing, and refuses MCP work', async () => {
      running = await start();
      running.app.close();
      const health = await fetch(`${running.base}/health`);
      expect(health.status).toBe(503);
      expect((await health.json()).status).toBe('shutting_down');
      expect((await fetch(`${running.base}/ready`)).status).toBe(503);
      const mcp = await post(running.base, INITIALIZE);
      expect(mcp.status).toBe(503);
      expect(mcp.headers.get('connection')).toBe('close');
    });
  });

  describe('fair sharing under load', () => {
    let upstream: { fail: () => void; aborted: () => number };

    beforeEach(() => {
      upstream = hangingUpstream(realFetch);
    });

    afterEach(async () => {
      upstream.fail();
      await waitFor(() => expect(fetchQueueStats()).toMatchObject({ active: 0, queued: 0 }));
    });

    it('gives each client its share of the slots and serves queued work when a slot frees', async () => {
      running = await start({
        ...VIA_PROXY,
        limits: limits({ maxConcurrentRequests: 2, maxConcurrentPerClient: 1 }),
      });
      const a1 = post(running.base, readDoc('a1'), as('10.0.0.1'));
      await waitFor(() => expect(running.app.stats().inFlightRequests).toBe(1));
      const a2 = post(running.base, readDoc('a2'), as('10.0.0.1'));
      await waitFor(() => expect(running.app.stats().queuedRequests).toBe(1));
      // Client A is at its share; client B still gets the free slot at once.
      const b1 = post(running.base, readDoc('b1'), as('10.0.0.2'));
      await waitFor(() => expect(running.app.stats().inFlightRequests).toBe(2));
      expect(running.app.stats()).toMatchObject({ queuedRequests: 1, requestClients: 2 });
      upstream.fail();
      for (const res of await Promise.all([a1, a2, b1])) expect(res.status).toBe(200);
      expect(running.app.stats()).toMatchObject({ inFlightRequests: 0, queuedRequests: 0, requestClients: 0 });
    });

    it('hands a freed slot to the first queued client that is under its share', async () => {
      running = await start({
        ...VIA_PROXY,
        limits: limits({ maxConcurrentRequests: 2, maxConcurrentPerClient: 1 }),
      });
      const b1 = new AbortController();
      keep(post(running.base, readDoc('a1'), as('10.0.0.1')));
      keep(post(running.base, readDoc('b1'), as('10.0.0.2'), b1.signal));
      await waitFor(() => expect(running.app.stats().inFlightRequests).toBe(2));
      keep(post(running.base, readDoc('a2'), as('10.0.0.1')));
      await waitFor(() => expect(running.app.stats().queuedRequests).toBe(1));
      keep(post(running.base, readDoc('c1'), as('10.0.0.3')));
      await waitFor(() => expect(running.app.stats().queuedRequests).toBe(2));
      // B leaves: its slot goes to C, queued behind A — A is still at its share.
      b1.abort();
      await waitFor(() => expect(running.app.stats()).toMatchObject({ inFlightRequests: 2, queuedRequests: 1 }));
      expect(running.app.stats().requestClients).toBe(2);
    });

    it('answers 503 when the wait runs out, and at once when the client already fills its queue share', async () => {
      running = await start({
        ...VIA_PROXY,
        limits: limits({ maxConcurrentRequests: 1, maxConcurrentPerClient: 1, queueWaitMs: 150 }),
      });
      keep(post(running.base, readDoc('busy'), as('10.0.0.1')));
      await waitFor(() => expect(running.app.stats().inFlightRequests).toBe(1));
      const waiting = post(running.base, readDoc('w'), as('10.0.0.2'));
      await waitFor(() => expect(running.app.stats().queuedRequests).toBe(1));
      const refused = await post(running.base, readDoc('r'), as('10.0.0.2'));
      expect(refused.status).toBe(503);
      expect(refused.headers.get('retry-after')).toBe('1');
      const timedOut = await waiting;
      expect(timedOut.status).toBe(503);
      expect((await timedOut.json()).error.message).toContain('too many requests in progress');
      expect(running.app.stats().queuedRequests).toBe(0);
    });

    it('tells a client refused at its own share that the limit is its own, not the server being busy', async () => {
      running = await start({
        ...VIA_PROXY,
        limits: limits({ maxConcurrentRequests: 4, maxConcurrentPerClient: 1, queueWaitMs: 150 }),
      });
      keep(post(running.base, readDoc('busy'), as('10.0.0.1')));
      await waitFor(() => expect(running.app.stats().inFlightRequests).toBe(1));
      const second = await post(running.base, readDoc('again'), as('10.0.0.1'));
      expect(second.status).toBe(503);
      expect((await second.json()).error.message).toBe(
        'Too many requests in progress from this client (1 at once); retry when one has finished'
      );
    });

    it('never makes initialize, ping, the list methods or notifications wait for a slot', async () => {
      running = await start({ limits: limits({ maxConcurrentRequests: 1, maxQueuedRequests: 0 }) });
      keep(post(running.base, readDoc('busy')));
      await waitFor(() => expect(running.app.stats().inFlightRequests).toBe(1));
      expect((await post(running.base, LIST_DOCS)).status).toBe(503);
      expect((await post(running.base, INITIALIZE)).status).toBe(200);
      expect((await post(running.base, { jsonrpc: '2.0', id: 4, method: 'ping' })).status).toBe(200);
      expect((await post(running.base, TOOLS_LIST)).status).toBe(200);
      expect((await post(running.base, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
      // A JSON-RPC response (no method) carries no work either.
      expect((await post(running.base, { jsonrpc: '2.0', id: 5, result: {} })).status).toBe(202);
    });

    it('lets list_docs and find_across_sdks skip the slots once the files they need are in memory', async () => {
      running = await start({
        indexLoaded: () => true,
        fullTextLoaded: () => true,
        limits: limits({ maxConcurrentRequests: 1, maxQueuedRequests: 0 }),
      });
      keep(post(running.base, readDoc('busy')));
      await waitFor(() => expect(running.app.stats().inFlightRequests).toBe(1));
      expect((await post(running.base, LIST_DOCS)).status).toBe(200);
      const across = { ...LIST_DOCS, params: { name: 'find_across_sdks', arguments: { query: 'markers' } } };
      expect((await post(running.base, across)).status).toBe(200);
      expect((await post(running.base, readDoc('other'))).status).toBe(503);
    });

    it('lets find_across_sdks skip the slots only with every page-contents file in memory too', async () => {
      // It checks some pages' text (llms-full.txt): without it, the call may download it.
      running = await start({
        indexLoaded: () => true,
        fullTextLoaded: (id) => id !== 'ios',
        limits: limits({ maxConcurrentRequests: 1, maxQueuedRequests: 0 }),
      });
      keep(post(running.base, readDoc('busy')));
      await waitFor(() => expect(running.app.stats().inFlightRequests).toBe(1));
      expect((await post(running.base, LIST_DOCS)).status).toBe(200);
      const across = { ...LIST_DOCS, params: { name: 'find_across_sdks', arguments: { query: 'markers' } } };
      expect((await post(running.base, across)).status).toBe(503);
    });

    it('checks only the indexes a call needs: a Flutter listing skips the slots with the Flutter index alone', async () => {
      running = await start({
        indexLoaded: (id) => id === 'flutter',
        limits: limits({ maxConcurrentRequests: 1, maxQueuedRequests: 0 }),
      });
      keep(post(running.base, readDoc('busy')));
      await waitFor(() => expect(running.app.stats().inFlightRequests).toBe(1));
      expect((await post(running.base, LIST_DOCS)).status).toBe(200);
      // A listing of everything and a cross-SDK lookup need every index.
      const all = { ...LIST_DOCS, params: { name: 'list_docs', arguments: { source: 'all' } } };
      expect((await post(running.base, all)).status).toBe(503);
      const across = { ...LIST_DOCS, params: { name: 'find_across_sdks', arguments: { query: 'markers' } } };
      expect((await post(running.base, across)).status).toBe(503);
      // find_across_sdks has no source parameter: a stray one changes nothing.
      const stray = {
        ...LIST_DOCS,
        params: { name: 'find_across_sdks', arguments: { query: 'markers', source: 'flutter' } },
      };
      expect((await post(running.base, stray)).status).toBe(503);
    });

    it('reads which indexes are in memory from the index memo by default', async () => {
      resetCaches();
      seedIndex('flutter', FLUTTER_LLMS);
      running = await start({
        indexLoaded: undefined,
        limits: limits({ maxConcurrentRequests: 1, maxQueuedRequests: 0 }),
      });
      keep(post(running.base, readDoc('busy')));
      await waitFor(() => expect(running.app.stats().inFlightRequests).toBe(1));
      expect((await post(running.base, LIST_DOCS)).status).toBe(200);
      const ios = { ...LIST_DOCS, params: { name: 'list_docs', arguments: { source: 'ios' } } };
      expect((await post(running.base, ios)).status).toBe(503);
    });

    it('reads which page contents are in memory from the page-contents memo by default', async () => {
      resetCaches();
      for (const s of DOCS.sources) seedIndex(s.id, FLUTTER_LLMS);
      running = await start({
        indexLoaded: undefined,
        fullTextLoaded: undefined,
        limits: limits({ maxConcurrentRequests: 1, maxQueuedRequests: 0 }),
      });
      keep(post(running.base, readDoc('busy')));
      await waitFor(() => expect(running.app.stats().inFlightRequests).toBe(1));
      const across = { ...LIST_DOCS, params: { name: 'find_across_sdks', arguments: { query: 'markers' } } };
      expect((await post(running.base, across)).status).toBe(503);
      for (const s of DOCS.sources) seedFullTextSections(s.id, FLUTTER_FULL);
      expect((await post(running.base, across)).status).toBe(200);
    });

    it('reports "saturated" while the queue is full: 503 on /ready, but /health stays 200', async () => {
      running = await start({
        ...VIA_PROXY,
        limits: limits({ maxConcurrentRequests: 1, maxConcurrentPerClient: 1, maxQueuedRequests: 1 }),
      });
      keep(post(running.base, readDoc('busy'), as('10.0.0.1')));
      await waitFor(() => expect(running.app.stats().inFlightRequests).toBe(1));
      const queued = post(running.base, readDoc('q'), as('10.0.0.2'));
      await waitFor(() => expect(running.app.stats().queuedRequests).toBe(1));
      const ready = await fetch(`${running.base}/ready`);
      expect(ready.status).toBe(503);
      const body = (await ready.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        status: 'saturated',
        reasons: ['request queue full', 'all request slots busy'],
        inFlightRequests: 1,
        queuedRequests: 1,
        outbound: { active: 1, queued: 0 },
      });
      // Load never fails the liveness probe: a restart would only add to it.
      const health = await fetch(`${running.base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual(body);
      upstream.fail();
      expect((await queued).status).toBe(200);
      expect((await fetch(`${running.base}/ready`)).status).toBe(200);
    });

    it("cancels a disconnected client's tool work and frees its slot only when the work stopped", async () => {
      running = await start({ limits: limits({ maxConcurrentRequests: 1 }) });
      const controller = new AbortController();
      const gone = post(running.base, readDoc('gone'), {}, controller.signal).catch(() => 'aborted');
      await waitFor(() => expect(fetchQueueStats().active).toBe(1));
      controller.abort();
      await gone; // the SSE headers may already be out: either way the client is gone
      await waitFor(() => expect(running.app.stats().inFlightRequests).toBe(0));
      expect(upstream.aborted()).toBe(1);
      expect(fetchQueueStats()).toMatchObject({ active: 0, queued: 0 });
    });

    it('drops a queued request whose client disconnects', async () => {
      running = await start({ limits: limits({ maxConcurrentRequests: 1 }) });
      keep(post(running.base, readDoc('busy')));
      await waitFor(() => expect(running.app.stats().inFlightRequests).toBe(1));
      const controller = new AbortController();
      const gone = post(running.base, readDoc('q'), {}, controller.signal).catch(() => 'aborted');
      await waitFor(() => expect(running.app.stats().queuedRequests).toBe(1));
      controller.abort();
      expect(await gone).toBe('aborted');
      await waitFor(() => expect(running.app.stats().queuedRequests).toBe(0));
    });
  });

  describe('per-client budgets', () => {
    it("gives each client its own share of the body budget, so one client's stalled bodies block only it", async () => {
      running = await start({ ...VIA_PROXY, limits: limits({ maxInFlightBodyBytesPerClient: 64 }) });
      const { socket } = await openSocket(
        running.port,
        `POST ${MCP_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: 10.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n${'{'.repeat(64)}`
      );
      await waitFor(() => expect(running.app.stats().inFlightBodyBytes).toBe(64));
      const same = await post(running.base, TOOLS_LIST, as('10.0.0.1'));
      expect(same.status).toBe(503);
      expect((await same.json()).error.message).toContain('from this client');
      expect((await post(running.base, TOOLS_LIST, as('10.0.0.2'))).status).toBe(200);
      socket.destroy();
      await waitFor(() => expect(running.app.stats()).toMatchObject({ inFlightBodyBytes: 0, bodyClients: 0 }));
    });

    it('stops reading a body that takes the client past its share, closing the connection', async () => {
      running = await start({ limits: limits({ maxInFlightBodyBytesPerClient: 64 }) });
      const { socket, response } = await openSocket(
        running.port,
        `POST ${MCP_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n${'{'.repeat(70)}`
      );
      const data = await response();
      socket.destroy();
      expect(data).toContain('HTTP/1.1 503');
      expect(data).toContain('Connection: close');
      expect(data).toContain('from this client');
      expect(running.app.stats()).toMatchObject({ inFlightBodyBytes: 0, bodyClients: 0 });
    });

    it('counts an expensive tool call as several requests against the rate limit', async () => {
      running = await start({ limits: limits({ rateLimitMax: 6, toolCallCosts: { list_docs: 5 } }) });
      expect((await post(running.base, LIST_DOCS)).status).toBe(200); // 1 + 4 = 5
      expect((await post(running.base, TOOLS_LIST)).status).toBe(200); // 6
      const limited = await post(running.base, LIST_DOCS);
      expect(limited.status).toBe(429);
      expect((await limited.json()).error.message).toBe(
        'Rate limit exceeded (6 requests per 60s; a list_docs call counts 5)'
      );
      expect(limited.headers.get('retry-after')).toBe('60');
      await running.stop();
      // A weighted call refused after arrival is not charged: the window is not shortened by it.
      running = await start({ limits: limits({ rateLimitMax: 6, toolCallCosts: { list_docs: 5 } }) });
      expect((await post(running.base, TOOLS_LIST)).status).toBe(200); // 1
      expect((await post(running.base, TOOLS_LIST)).status).toBe(200); // 2
      expect((await post(running.base, LIST_DOCS)).status).toBe(429); // 3 + 4 would be 7: refused, back to 3
      expect((await post(running.base, TOOLS_LIST)).status).toBe(200); // 4
      expect((await post(running.base, TOOLS_LIST)).status).toBe(200); // 5
      expect((await post(running.base, TOOLS_LIST)).status).toBe(200); // 6
      expect((await post(running.base, TOOLS_LIST)).status).toBe(429);
      await running.stop();
      // Admitted on arrival, refused once the body shows what the call costs.
      running = await start({ limits: limits({ rateLimitMax: 3, toolCallCosts: { list_docs: 5 } }) });
      // A tools/call without a tool name costs one request.
      const nameless = await post(running.base, { jsonrpc: '2.0', id: 6, method: 'tools/call' });
      expect(nameless.status).toBe(200);
      expect((await post(running.base, LIST_DOCS)).status).toBe(429);
    });
  });

  describe('MCP endpoint (stateless)', () => {
    it('serves a complete SDK client session without issuing session ids', async () => {
      running = await start();
      const transport = new StreamableHTTPClientTransport(new URL(`${running.base}${MCP_PATH}`));
      const client = new Client({ name: 'test', version: '0' });
      await client.connect(transport);
      expect(transport.sessionId).toBeUndefined();
      expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(8);
      const result = await client.callTool({ name: 'list_docs', arguments: { source: 'flutter' } });
      expect(textOf(result)).toContain('[Calculate Route](');
      await client.close();
      expect(running.app.stats().inFlightRequests).toBe(0);
    });

    it('answers a bare JSON-RPC request without a prior initialize', async () => {
      running = await start();
      const res = await post(running.base, TOOLS_LIST);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('"search_docs"');
    });

    it('rejects batched (array) requests', async () => {
      running = await start();
      const res = await post(running.base, [INITIALIZE, TOOLS_LIST]);
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toContain('Batched (array) requests are not supported');
    });

    it('answers GET and DELETE with 405 (no sessions, no streams) and PUT too', async () => {
      running = await start();
      for (const method of ['GET', 'DELETE', 'PUT']) {
        const res = await fetch(`${running.base}${MCP_PATH}`, { method, headers: JSON_HEADERS });
        expect(res.status, method).toBe(405);
        expect(res.headers.get('allow')).toBe('POST, OPTIONS');
      }
    });

    it('rejects an invalid or empty JSON body with 400', async () => {
      running = await start();
      const bad = await fetch(`${running.base}${MCP_PATH}`, { method: 'POST', headers: JSON_HEADERS, body: '{nope' });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error.code).toBe(-32700);
      const empty = await fetch(`${running.base}${MCP_PATH}`, { method: 'POST', headers: JSON_HEADERS, body: '' });
      expect(empty.status).toBe(400);
    });

    it('rejects an oversized body announced by Content-Length before reading it, closing the connection', async () => {
      running = await start();
      const res = await raw(running.port, MCP_PATH, {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'content-length': '5000' },
        body: 'x'.repeat(5000),
      });
      expect(res.status).toBe(413);
      expect(res.headers.connection).toBe('close');
      expect(JSON.parse(res.body).error.message).toBe('Request body exceeds 4096 bytes');
    });

    it('rejects an oversized chunked body while streaming it', async () => {
      running = await start();
      const res = await raw(running.port, MCP_PATH, {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'transfer-encoding': 'chunked' },
        body: 'x'.repeat(5000),
      });
      expect(res.status).toBe(413);
      expect(running.app.stats().inFlightBodyBytes).toBe(0);
    });

    it('times out a body that never finishes arriving, with 408', async () => {
      running = await start({
        limits: limits({ bodyTimeoutMs: 100 }),
      });
      const { socket, response } = await openSocket(
        running.port,
        `POST ${MCP_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: 100\r\n\r\n{"jsonrpc"`
      );
      const data = await response();
      socket.destroy();
      expect(data).toContain('HTTP/1.1 408');
      expect(data).toContain('not received within 100 ms');
      expect(running.app.stats().inFlightBodyBytes).toBe(0);
    });

    it('refuses new bodies with 503 while the in-flight body budget is spent', async () => {
      running = await start({
        limits: limits({ maxInFlightBodyBytes: 20 }),
      });
      const { socket } = await openSocket(
        running.port,
        `POST ${MCP_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n${'{'.repeat(30)}`
      );
      await waitFor(() => expect(running.app.stats().inFlightBodyBytes).toBe(30));
      // A tiny body (a ping) is exempt from the server-wide budget; a bigger one is not.
      expect((await post(running.base, TOOLS_LIST)).status).toBe(200);
      const big = { ...LIST_DOCS, params: { ...LIST_DOCS.params, _meta: { pad: 'x'.repeat(2000) } } };
      const res = await post(running.base, big);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      expect((await res.json()).error.message).toContain('memory budget');
      const health = await (await fetch(`${running.base}/health`)).json();
      expect(health).toMatchObject({ status: 'degraded', reasons: ['request body budget spent'] });
      socket.destroy();
      await waitFor(() => expect(running.app.stats().inFlightBodyBytes).toBe(0));
    });

    it('stays "degraded" for 10 s after refusing a body for the budget, though it is no longer spent', async () => {
      let clock = 1_000_000;
      running = await start({ now: () => clock, limits: limits({ maxInFlightBodyBytes: 20 }) });
      const { socket } = await openSocket(
        running.port,
        `POST ${MCP_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n${'{'.repeat(30)}`
      );
      await waitFor(() => expect(running.app.stats().inFlightBodyBytes).toBe(30));
      const big = { ...LIST_DOCS, params: { ...LIST_DOCS.params, _meta: { pad: 'x'.repeat(2000) } } };
      expect((await post(running.base, big)).status).toBe(503);
      socket.destroy();
      await waitFor(() => expect(running.app.stats().inFlightBodyBytes).toBe(0));
      expect(await (await fetch(`${running.base}/health`)).json()).toMatchObject({
        status: 'degraded',
        reasons: ['request body budget spent'],
      });
      clock += 10_001;
      expect(await (await fetch(`${running.base}/health`)).json()).toMatchObject({ status: 'ok' });
    });

    it('cuts off bodies stalled for over 2 s once half the budget is in use, so others get through', async () => {
      let clock = 1_000_000;
      running = await start({ now: () => clock, limits: limits({ maxInFlightBodyBytes: 4096 }) });
      const stalled = await openSocket(
        running.port,
        `POST ${MCP_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 3000\r\n\r\n${'{'.repeat(2100)}`
      );
      await waitFor(() => expect(running.app.stats().inFlightBodyBytes).toBe(2100));
      const big = { ...LIST_DOCS, params: { ...LIST_DOCS.params, _meta: { pad: 'x'.repeat(2000) } } };
      // Not stalled long enough yet: refused.
      expect((await post(running.base, big)).status).toBe(503);
      clock += 2_001;
      expect((await post(running.base, big)).status).toBe(200);
      const data = await stalled.response();
      stalled.socket.destroy();
      expect(data).toContain('HTTP/1.1 408');
      expect(running.app.stats().inFlightBodyBytes).toBe(0);
    });

    it('cuts a body that started before a backward clock step as stalled, not after the length of the step', async () => {
      let clock = 1_000_000;
      running = await start({ now: () => clock, limits: limits({ maxInFlightBodyBytes: 4096 }) });
      const stalled = await openSocket(
        running.port,
        `POST ${MCP_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 3000\r\n\r\n${'{'.repeat(2100)}`
      );
      await waitFor(() => expect(running.app.stats().inFlightBodyBytes).toBe(2100));
      // The wall clock steps back an hour: the body's start now lies in the
      // future. A reading from before the step counts as expired, not as a
      // body that has another hour before it is stalled.
      clock -= 3_600_000;
      const big = { ...LIST_DOCS, params: { ...LIST_DOCS.params, _meta: { pad: 'x'.repeat(2000) } } };
      expect((await post(running.base, big)).status).toBe(200);
      const data = await stalled.response();
      stalled.socket.destroy();
      expect(data).toContain('HTTP/1.1 408');
      expect(running.app.stats().inFlightBodyBytes).toBe(0);
    });

    it('cuts the bodies of clients holding more than a fair share when the budget is full, so a newcomer fits', async () => {
      let clock = 1_000_000;
      running = await start({ ...VIA_PROXY, now: () => clock, limits: limits({ maxInFlightBodyBytes: 6000 }) });
      const stalled = (ip: string, bytes: number): Promise<{ socket: Socket; response: () => Promise<string> }> =>
        openSocket(
          running.port,
          `POST ${MCP_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: ${ip}\r\nContent-Type: application/json\r\nContent-Length: ${bytes + 1}\r\n\r\n${'{'.repeat(bytes)}`
        );
      const padded = (bytes: number): unknown => {
        const base = JSON.stringify({ ...LIST_DOCS, params: { ...LIST_DOCS.params, _meta: { pad: '' } } }).length;
        return { ...LIST_DOCS, params: { ...LIST_DOCS.params, _meta: { pad: 'x'.repeat(bytes - base) } } };
      };
      const bytes = (): number => running.app.stats().inFlightBodyBytes;

      // Full, with two clients over the share of 2000 (three holders with the
      // newcomer): the biggest holder's bodies go first, oldest first, then
      // the next holder's, until the newcomer fits.
      // (Each stalled body declares one byte more than it sends, and is
      // opened so that its own declared length cuts nobody.)
      const b1 = await stalled('10.0.0.2', 2001);
      const a1 = await stalled('10.0.0.1', 2000);
      clock += 1;
      const a2 = await stalled('10.0.0.1', 1999);
      await waitFor(() => expect(bytes()).toBe(6000));
      expect((await post(running.base, padded(4096), as('10.0.0.3'))).status).toBe(200);
      expect(await a1.response()).toContain('HTTP/1.1 408');
      expect(await a2.response()).toContain('cut off: this client held more than its share');
      expect(await b1.response()).toContain('HTTP/1.1 408');
      await waitFor(() => expect(bytes()).toBe(0));
      for (const { socket } of [a1, a2, b1]) socket.destroy();

      // Cutting everyone over the share (10.0.0.3 alone) frees 4000, not enough for 4096: refused.
      const b2 = await stalled('10.0.0.2', 1000);
      const c1 = await stalled('10.0.0.3', 2000);
      const d1 = await stalled('10.0.0.4', 1000);
      clock += 1;
      const c2 = await stalled('10.0.0.3', 2000);
      await waitFor(() => expect(bytes()).toBe(6000));
      expect((await post(running.base, padded(4096), as('10.0.0.5'))).status).toBe(503);
      expect(await c1.response()).toContain('HTTP/1.1 408');
      expect(await c2.response()).toContain('HTTP/1.1 408');
      await waitFor(() => expect(bytes()).toBe(2000));
      c1.socket.destroy();
      c2.socket.destroy();

      // The cutting stops as soon as the newcomer fits: one body of the holder
      // over its share — here for a chunked request, which declares no length.
      const e1 = await stalled('10.0.0.6', 2000);
      clock += 1;
      const e2 = await stalled('10.0.0.6', 2000);
      await waitFor(() => expect(bytes()).toBe(6000));
      const chunked = await fetch(`${running.base}${MCP_PATH}`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, ...as('10.0.0.7') },
        body: new Blob([JSON.stringify(padded(1500))]).stream(),
        duplex: 'half',
      } as RequestInit);
      expect(chunked.status).toBe(200);
      expect(await e1.response()).toContain('HTTP/1.1 408');
      expect(bytes()).toBe(4000);
      for (const { socket } of [b2, d1, e1, e2]) socket.destroy();
      await waitFor(() => expect(bytes()).toBe(0));
    });

    it('cuts over-share bodies when the budget is held just short of full, before or while a newcomer streams', async () => {
      let clock = 1_000_000;
      running = await start({ ...VIA_PROXY, now: () => clock, limits: limits({ maxInFlightBodyBytes: 6000 }) });
      const stalled = (ip: string, bytes: number): Promise<{ socket: Socket; response: () => Promise<string> }> =>
        openSocket(
          running.port,
          `POST ${MCP_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: ${ip}\r\nContent-Type: application/json\r\nContent-Length: ${bytes + 1}\r\n\r\n${'{'.repeat(bytes)}`
        );
      const padded = (bytes: number): unknown => {
        const base = JSON.stringify({ ...LIST_DOCS, params: { ...LIST_DOCS.params, _meta: { pad: '' } } }).length;
        return { ...LIST_DOCS, params: { ...LIST_DOCS.params, _meta: { pad: 'x'.repeat(bytes - base) } } };
      };
      const bytes = (): number => running.app.stats().inFlightBodyBytes;

      // 100 bytes short of full: the newcomer's declared 1500 would not fit,
      // so the holder over the share of 2000 gives way first.
      const a1 = await stalled('10.0.0.1', 2000);
      clock += 1;
      const a2 = await stalled('10.0.0.1', 1900);
      const b1 = await stalled('10.0.0.2', 2000);
      await waitFor(() => expect(bytes()).toBe(5900));
      expect((await post(running.base, padded(1500), as('10.0.0.3'))).status).toBe(200);
      expect(await a1.response()).toContain('HTTP/1.1 408');
      await waitFor(() => expect(bytes()).toBe(3900));

      // A chunked body declares nothing, so it is admitted; when its bytes
      // overrun the budget, the holder over its share gives way then.
      const a3 = await stalled('10.0.0.1', 2000);
      await waitFor(() => expect(bytes()).toBe(5900));
      const chunked = await fetch(`${running.base}${MCP_PATH}`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, ...as('10.0.0.4') },
        body: new Blob([JSON.stringify(padded(1500))]).stream(),
        duplex: 'half',
      } as RequestInit);
      expect(chunked.status).toBe(200);
      expect(await a2.response()).toContain('cut off: this client held more than its share');
      for (const { socket } of [a1, a2, a3, b1]) socket.destroy();
      await waitFor(() => expect(bytes()).toBe(0));
    });

    it('refuses a body declared over the size cap with 413 before it cuts anyone', async () => {
      running = await start({ ...VIA_PROXY, limits: limits({ maxInFlightBodyBytes: 6000, maxBodyBytes: 5000 }) });
      const held = await openSocket(
        running.port,
        `POST ${MCP_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: 10.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n\r\n${'{'.repeat(4500)}`
      );
      await waitFor(() => expect(running.app.stats().inFlightBodyBytes).toBe(4500));
      const huge = await openSocket(
        running.port,
        `POST ${MCP_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: 10.0.0.2\r\nContent-Type: application/json\r\nContent-Length: 10000000000\r\n\r\n{`
      );
      expect(await huge.response()).toContain('HTTP/1.1 413');
      huge.socket.destroy();
      // The holder over its share (3000 of 6000 with the newcomer) was not cut.
      expect(running.app.stats().inFlightBodyBytes).toBe(4500);
      held.socket.destroy();
      await waitFor(() => expect(running.app.stats().inFlightBodyBytes).toBe(0));
    });

    it('charges the server-wide budget as bodies arrive: slow bodies admitted together cannot exceed it', async () => {
      running = await start({
        limits: limits({ maxInFlightBodyBytes: 30 }),
      });
      const head = `POST ${MCP_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 2000\r\n\r\n`;
      const first = await openSocket(running.port, `${head}${'{'.repeat(20)}`);
      await waitFor(() => expect(running.app.stats().inFlightBodyBytes).toBe(20));
      // Admitted (20 < 30), then refused as its bytes take the total past the budget.
      const second = await openSocket(running.port, `${head}${'{'.repeat(20)}`);
      const data = await second.response();
      second.socket.destroy();
      expect(data).toContain('HTTP/1.1 503');
      expect(data).toContain('exceed the memory budget');
      expect(data.toLowerCase()).toContain('connection: close');
      await waitFor(() => expect(running.app.stats().inFlightBodyBytes).toBe(20));
      first.socket.destroy();
      await waitFor(() => expect(running.app.stats().inFlightBodyBytes).toBe(0));
    });

    it('caps concurrent MCP requests with 503 when there is no room to queue', async () => {
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slowServer = (): McpServer => {
        const server = createServer();
        const connect = server.connect.bind(server);
        server.connect = async (transport) => {
          await gate;
          return connect(transport);
        };
        return server;
      };
      running = await start({
        createServer: slowServer,
        limits: limits({ maxConcurrentRequests: 1, maxQueuedRequests: 0 }),
      });
      const first = post(running.base, LIST_DOCS);
      await waitFor(() => expect(running.app.stats().inFlightRequests).toBe(1));
      const second = await post(running.base, LIST_DOCS);
      expect(second.status).toBe(503);
      expect((await second.json()).error.message).toContain('too many requests in progress');
      release();
      expect((await first).status).toBe(200);
      expect(running.app.stats().inFlightRequests).toBe(0);
    });

    it('answers 500 when the server factory throws, and only ends an already-started response', async () => {
      running = await start({
        createServer: () => {
          throw new Error('factory exploded');
        },
      });
      const res = await post(running.base, TOOLS_LIST);
      expect(res.status).toBe(500);
      expect((await res.json()).error.message).toBe('Internal server error');
      expect(stderr).toHaveBeenCalledWith('Error handling MCP request:', expect.any(Error));

      const ended: string[] = [];
      const res2 = {
        headersSent: true,
        setHeader: () => {},
        writeHead: () => res2,
        end: () => ended.push('end'),
      } as unknown as ServerResponse;
      const req = Object.assign(
        (async function* () {
          yield Buffer.from(JSON.stringify(TOOLS_LIST));
        })(),
        { method: 'POST', url: MCP_PATH, headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } }
      ) as unknown as IncomingMessage;
      running.app.handler(req, res2);
      await waitFor(() => expect(ended).toEqual(['end']));
    });

    it('uses the wall clock when no clock is injected', async () => {
      running = await start({ now: undefined });
      expect((await fetch(`${running.base}/health`)).status).toBe(200);
    });
  });
});

describe('reloadOrder', () => {
  it('reloads the files tried longest ago first, so files that keep hanging do not keep the others waiting', () => {
    const file = (source: string, part: UpstreamFailure['part'] = 'full-text'): UpstreamFailure => ({
      source,
      part,
      reason: 'timeout',
      serving: 'nothing',
    });
    const all = [file('developer'), file('flutter'), file('android'), file('ios', 'index')];
    expect(reloadOrder(all).map((f) => f.source)).toEqual(['developer', 'flutter', 'android', 'ios']);
    // developer's and flutter's downloads got going at some point; android's and ios's never did
    // (no slot, or cut short): those come first, then the one that started longest ago.
    const started = [{ ...all[0]!, startedAt: 300 }, { ...all[1]!, startedAt: 200 }, all[2]!, all[3]!];
    expect(reloadOrder(started).map((f) => f.source)).toEqual(['android', 'ios', 'flutter', 'developer']);
    expect(started.map((f) => f.source)).toEqual(['developer', 'flutter', 'android', 'ios']); // not sorted in place
    // A file whose last download was sent and got no answer (the site hung for
    // it) goes after every other, however long ago that was: it would hold a
    // background slot for 20 s while a file that failed fast waits.
    const hung = [
      { ...all[0]!, startedAt: 100, hung: true as const },
      { ...all[1]!, startedAt: 200 },
      { ...all[2]!, startedAt: 300, hung: true as const },
      all[3]!,
    ];
    expect(reloadOrder(hung).map((f) => f.source)).toEqual(['ios', 'flutter', 'developer', 'android']);
  });
});
