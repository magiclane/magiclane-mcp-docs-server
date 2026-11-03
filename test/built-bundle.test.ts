/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The BUILT bundles, offline: the stdio one must announce the same tools and
 * resources as the sources it was built from, and end with its client; the
 * HTTP one (the Docker CMD, whose entry unit coverage leaves out) must serve,
 * stop on SIGTERM and fail on a taken port. The unit tests and the
 * manifest check both load src/, so this is the one place a stale or broken
 * dist/ shows. Runs whenever the bundle exists: `npm run check` and the
 * release build first, so there it always runs. Without a build, a bare
 * `npm test` skips it — counted among the skipped tests; the reason is
 * printed only by the verbose reporter.
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { connect as netConnect, createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FETCH, STDIO } from '../src/config/constants.js';
import { createServer } from '../src/server.js';
import { SERVER_NAME, SERVER_VERSION } from '../src/version.js';

const entry = 'dist/docs-server.esm.js';
/** Preloaded into every spawned bundle: its fetches fail instead of reaching the network (a URL: on Windows a path is not one). */
const noNetwork = ['--import', new URL('./no-network.mjs', import.meta.url).href];

interface JsonRpcResponse {
  id?: number;
  result?: any;
  error?: { code: number; message: string };
}

if (!existsSync(entry))
  console.warn(`${entry} is not built: the built-bundle check is skipped (run \`npm run build\`).`);

describe.skipIf(!existsSync(entry))('built stdio bundle (offline)', () => {
  let child: ChildProcess;
  const pending = new Map<number, (msg: JsonRpcResponse) => void>();
  let nextId = 1;

  function request(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** The same listing from the sources, through an in-memory client. */
  async function fromSources<T>(call: (client: Client) => Promise<T>): Promise<T> {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'bundle-check', version: '0' });
    await Promise.all([createServer().connect(b), client.connect(a)]);
    try {
      return await call(client);
    } finally {
      await client.close();
    }
  }

  beforeAll(async () => {
    child = spawn('node', [...noNetwork, entry], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      }
    });
    const init = await request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'bundle-check', version: '0.0.0' },
    });
    expect(init.result.serverInfo).toEqual({ name: SERVER_NAME, version: SERVER_VERSION });
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  });

  afterAll(() => {
    child?.kill();
  });

  it('lists the same tools, with the same schemas, as the sources', async () => {
    const built = (await request('tools/list', {})).result.tools;
    const source = (await fromSources((c) => c.listTools())).tools;
    expect(built.map((t: { name: string }) => t.name)).toEqual(source.map((t) => t.name));
    expect(built).toEqual(source);
  });

  it('lists the same resources as the sources', async () => {
    const built = (await request('resources/list', {})).result.resources;
    const source = (await fromSources((c) => c.listResources())).resources;
    expect(built.map((r: { uri: string }) => r.uri)).toEqual(source.map((r) => r.uri));
    expect(built).toEqual(source);
  });
});

/**
 * Runs the built stdio bundle on `input`, then (if asked) closes its stdin;
 * resolves with its exit, output and stderr. `fetchDelayMs` makes the
 * server's fetches that slow; `indexPages` has them serve an index of that
 * many pages (see no-network.mjs); `readStdoutAfterMs` leaves the server's
 * stdout unread that long, so its answers wait in the pipe and its own
 * write queue — as for a client busy elsewhere.
 */
function runStdio(
  input: string,
  closeStdin: boolean,
  fetchDelayMs = 0,
  { indexPages = 0, readStdoutAfterMs = 0 } = {}
): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('node', [...noNetwork, entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TEST_FETCH_DELAY_MS: String(fetchDelayMs),
        TEST_FETCH_INDEX_PAGES: String(indexPages),
      },
    });
    let stdout = '';
    let stderr = '';
    const read = (): void => void child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    // Until the reader starts, the pipe holds 64 KiB and the parent one chunk
    // of 64 KiB more: an answer that is to wait in the server's own write
    // queue must be well over both. A server that exits before the reader
    // starts has its unread output dropped (Node resumes an untouched stdout
    // on exit), so what it wrote shows as nothing read.
    if (readStdoutAfterMs > 0) setTimeout(read, readStdoutAfterMs);
    else read();
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    // `close`, not `exit`: the process may end before a late reader has taken its output.
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin!.on('error', () => {}); // the server may exit before reading it all
    child.stdin!.write(input);
    if (closeStdin) setTimeout(() => child.stdin!.end(), 200);
  });
}

// Each test runs its own server process, so they run side by side: the
// longest waits out a request's own 20 s limit.
describe.skipIf(!existsSync(entry))('built stdio bundle: transport events', { concurrent: true }, () => {
  const init =
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'eof', version: '0' } },
    }) + '\n';

  it('exits 0 at once when the client closes stdin, and logs a line that is not JSON-RPC', async () => {
    const run = await runStdio(init + 'not json\n', true);
    expect(run.code).toBe(0);
    expect(run.ms).toBeLessThan(5_000);
    expect(run.stderr).toContain('MCP protocol error: Unexpected token');
  });

  it('logs which message the protocol rejected and why, and answers a request with an id', async () => {
    const bad = JSON.stringify({ jsonrpc: '2.0', id: 'bad', method: 'tools/call', params: ['search_docs'] }) + '\n';
    const noId = JSON.stringify({ jsonrpc: '1.0', method: 'ping' }) + '\n';
    const run = await runStdio(init + bad + noId, true);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain(
      'MCP protocol error (method tools/call, id "bad"): params: Invalid input: expected object, received array'
    );
    expect(run.stderr).toContain('MCP protocol error (method ping): jsonrpc: Invalid input: expected "2.0"');
    const answers = run.stdout
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { id?: number | string; error?: { code: number; message: string } });
    // The one without an id gets no answer. (The error answer may precede the
    // initialize answer: the SDK answers a tick later than the line check.)
    expect(answers.map((a) => a.id).sort()).toEqual([1, 'bad']);
    expect(answers.find((a) => a.id === 'bad')?.error).toEqual({
      code: -32600,
      message: 'Invalid Request: params: Invalid input: expected object, received array',
    });
  });

  it('finishes a call still running when the client closes stdin, and writes its whole answer before exiting 0', async () => {
    const call =
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) +
      '\n' +
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_docs', arguments: { source: 'flutter', mode: 'pages', limit: 100 } },
      }) +
      '\n';
    // The index takes 600 ms to arrive; stdin closes at 200 ms, with the call
    // still running. Its answer (100 long entries, over 230 KB) is far larger
    // than the pipe and the reader's buffer hold, and nobody reads the pipe
    // until 1.5 s: an exit that did not wait for stdout to take it all would
    // cut the answer.
    const readStdoutAfterMs = 1_500;
    const run = await runStdio(init + call, true, 600, { indexPages: 100, readStdoutAfterMs });
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('stdin closed: finishing 1 running call(s) first.');
    expect(run.stdout.length).toBeGreaterThan(3 * 65_536); // the pipe and the reader hold 64 KiB each
    const answers = run.stdout
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { id?: number; result?: { structuredContent?: { pages?: unknown[] } } });
    expect(answers.map((a) => a.id)).toEqual([1, 2]); // every line whole: nothing cut off by the exit
    expect(answers[1]?.result?.structuredContent?.pages).toHaveLength(100);
    // Gone once the reader had taken the answer — not before, and not much after.
    expect(run.ms).toBeGreaterThanOrEqual(readStdoutAfterMs);
    expect(run.ms).toBeLessThan(readStdoutAfterMs + 2_000);
  });

  it('waits for a request within its own limit, however late its first byte, and exits 0 with every answer', async () => {
    const call =
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) +
      '\n' +
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_docs', arguments: { source: 'flutter', mode: 'pages', limit: 3 } },
      }) +
      '\n';
    // The index's first byte comes 1.5 s past the grace; stdin closes at 200 ms (a one-shot pipe).
    const delay = STDIO.closeGraceMs + 1_500;
    const run = await runStdio(init + call, true, delay, { indexPages: 3 });
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('stdin closed: finishing 1 running call(s) first.');
    expect(run.stderr).not.toContain('giving up');
    const answers = run.stdout
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { id?: number; result?: { structuredContent?: { pages?: unknown[] } } });
    expect(answers.map((a) => a.id)).toEqual([1, 2]);
    expect(answers[1]?.result?.structuredContent?.pages).toHaveLength(3);
    expect(run.ms).toBeGreaterThanOrEqual(delay);
  });

  it('gives up, with status 1, a call whose request outlives its own limit, a grace after that limit', async () => {
    const call =
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) +
      '\n' +
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'read_doc', arguments: { url: '/docs/flutter/guides/hanging.md' } },
      }) +
      '\n';
    // The fetch sends nothing for 30 s and ignores its abort; stdin closes at 200 ms.
    const run = await runStdio(init + call, true, 30_000);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('stdin closed: finishing 1 running call(s) first.');
    expect(run.stderr).toContain(
      `Nothing to wait for from the site for ${STDIO.closeGraceMs / 1000} s since stdin closed (no request within its own limits, no byte): giving up the 1 running call(s).`
    );
    // Waited for while the site might still answer it, then a grace: not the fetch's 30 s.
    expect(run.ms).toBeGreaterThanOrEqual(FETCH.timeoutMs + STDIO.closeGraceMs);
    expect(run.ms).toBeLessThan(FETCH.timeoutMs + STDIO.closeGraceMs + 3_000);
    const answers = run.stdout
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { id?: number });
    expect(answers.map((a) => a.id)).toEqual([1]); // every line whole; the given-up call gets no answer
  });

  it('exits 1, saying why, when a line over the transport buffer closes it', async () => {
    const run = await runStdio(init + 'x'.repeat(11 * 1024 * 1024) + '\n', false);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('The stdio transport closed');
  });
});

const httpEntry = 'dist/docs-server-http.esm.js';

/** One request to the local server, through node:http (the test setup keeps fetch off the network). */
function local(port: number, path: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk: Buffer) => (text += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode as number, text }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** A port nothing listens on now. */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Starts the built HTTP bundle on `port`; resolves once it listens, or with its exit if it does not. */
function startHttp(port: number): Promise<{ child: ChildProcess; exited?: number | null; stderr: () => string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [...noNetwork, httpEntry], {
      env: { ...process.env, MCP_HTTP_PORT: String(port), MCP_HTTP_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening on')) resolve({ child, stderr: () => stderr });
    });
    child.on('exit', (code) => resolve({ child, exited: code, stderr: () => stderr }));
  });
}

describe.skipIf(!existsSync(httpEntry))('built HTTP bundle', () => {
  it('serves /health and tools/list, and exits 0 on SIGTERM (POSIX)', async () => {
    const port = await freePort();
    const { child, exited } = await startHttp(port);
    expect(exited).toBeUndefined();
    const health = await local(port, '/health');
    expect(health.status).toBe(200); // alive, though the indexes could not load: offline
    expect(health.text).toContain('must not reach the network'); // the preload is in effect
    const list = await local(port, '/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
    expect(list.status).toBe(200);
    expect(list.text).toContain('search_docs');
    // A connection with no call running on it (here: half a request line) does
    // not hold the exit for the 8 s grace: with no call running, it is closed at once.
    const halfSent = netConnect(port, '127.0.0.1');
    await new Promise<void>((resolve) => halfSent.once('connect', resolve));
    halfSent.on('error', () => {});
    halfSent.write('POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    const exit = new Promise<number | null>((resolve) => child.on('exit', resolve));
    const signalledAt = Date.now();
    child.kill('SIGTERM');
    // Windows has no signals: kill() ends the process at once, with no status.
    if (process.platform === 'win32') await exit;
    else {
      expect(await exit).toBe(0);
      expect(Date.now() - signalledAt).toBeLessThan(4_000);
    }
    halfSent.destroy();
  });

  it('exits 1 when its port is taken', async () => {
    const holder = createNetServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    try {
      const { exited, stderr } = await startHttp((holder.address() as AddressInfo).port);
      expect(exited).toBe(1);
      expect(stderr()).toContain('EADDRINUSE');
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });
});
