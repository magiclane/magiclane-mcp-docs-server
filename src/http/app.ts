/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Streamable HTTP application: request validation, rate limiting, body
 * limits, concurrency control and routing for the MCP endpoint, `/health` and
 * `/ready`.
 *
 * It runs the SDK transport STATELESS: no session ids are issued, so there is
 * no session table for one client to fill, nothing to evict, and nothing for
 * a restarted server to forget. Each POST gets a fresh server/transport pair
 * that is closed when the response ends. The protocol handshake still works —
 * `initialize` is answered like any other request — and the tools keep no
 * per-client state, so clients notice no difference except that the optional
 * GET notification stream (which this server never uses) is answered 405.
 *
 * Fairness: every limit that protects the process has a per-client share, so
 * one client (one IP, or one /64) cannot make the server refuse everyone. A
 * client gets at most `maxConcurrentPerClient` of the `maxConcurrentRequests`
 * slots and `maxInFlightBodyBytesPerClient` of the body budget; a request that
 * finds no free slot waits briefly in a bounded queue instead of being refused
 * at once; `initialize`, `ping` and the list methods, which never touch the
 * documentation host, skip the slots altogether; and an expensive tool call
 * counts as several requests against the rate limit. When a client goes away,
 * its tool work is cancelled — and its slot stays taken until that work has
 * really stopped.
 *
 * Everything here is a pure function of its options — limits, clock, the MCP
 * server factory — so the whole request surface is unit-tested over a real
 * `node:http` server on an ephemeral port. The process entry point only reads
 * the environment, wires this app to a listener and handles signals.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CorsPolicy, TrustedProxy } from '../utils/http-security.js';
import {
  clientIpFrom,
  hostRejectionMessage,
  isHostAllowed,
  isOriginAllowed,
  originRejectionMessage,
  rateLimitKey,
  resolveCorsAllowOrigin,
} from '../utils/http-security.js';
import { cacheStats, fetchesHanging, fetchQueueStats, sweepFetchBudgets } from '../utils/http-client.js';
import { withRequestContext } from '../utils/request-context.js';
import { withinLast } from '../utils/clock.js';
import { failingIndexes, loadIndex, loadedIndexCount, peekIndex } from '../docs/docs-index.js';
import { DOCS, FETCH } from '../config/constants.js';
import { failingFullTexts, fullTextStats, loadFullTextSections, peekFullTextSections } from '../docs/full-text.js';
import type { FailingFile } from '../docs/source-memo.js';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';

/** Operational limits; production values live in `HTTP` in config/constants.ts. */
export interface HttpLimits {
  /** Maximum accepted JSON-RPC request body size in bytes (413 beyond). */
  maxBodyBytes: number;
  /** Total body bytes that may be buffered at once across all connections (503 beyond). */
  maxInFlightBodyBytes: number;
  /** Body bytes one client may have buffered at once (503 beyond). */
  maxInFlightBodyBytesPerClient: number;
  /** Time allowed to receive a complete body (408 beyond). */
  bodyTimeoutMs: number;
  /** MCP requests executed at the same time, across all clients. */
  maxConcurrentRequests: number;
  /** MCP requests one client may have executing at the same time. */
  maxConcurrentPerClient: number;
  /** Requests that may wait for a slot at once (503 beyond). */
  maxQueuedRequests: number;
  /** How long a request waits for a slot before it is answered 503. */
  queueWaitMs: number;
  /** Requests allowed per client within one window (429 beyond). */
  rateLimitMax: number;
  /** Rate-limit window length. */
  rateLimitWindowMs: number;
  /** What one call of a tool counts against the rate limit (tools not listed count 1). */
  toolCallCosts: Readonly<Record<string, number>>;
  /** Rate-limit windows kept at once (default 100,000); when full, the oldest window is evicted. */
  maxRateBuckets?: number;
}

export interface HttpAppOptions {
  /** URL path of the MCP endpoint, e.g. `/mcp`. */
  mcpPath: string;
  /** Accepted Host header values (see `buildAllowedHosts`). */
  allowedHosts: Set<string>;
  /** Whether the Host header is validated at all. */
  dnsRebindingProtection: boolean;
  /** Browser-origin policy (see `parseCorsPolicy`). */
  corsPolicy: CorsPolicy;
  /** Trusted reverse-proxy hop count for `X-Forwarded-For`. */
  trustedProxyHops: number;
  /** Peers allowed to set `X-Forwarded-For` (see `parseTrustedProxies`). */
  trustedProxies: TrustedProxy[];
  limits: HttpLimits;
  /** Builds a fresh MCP server for each request. */
  createServer: () => McpServer;
  /** Clock, injectable so rate windows are testable. */
  now?: () => number;
  /**
   * Documentation files whose last download failed recently (default: the
   * index and full-text memos). Injectable so /health is testable without an
   * outage.
   */
  upstreamFailures?: () => UpstreamFailure[];
  /** How many sources' indexes are loaded (default: the index memo). Injectable for /ready tests. */
  indexesLoaded?: () => number;
  /** Whether one source's index is in memory (default: the index memo). Injectable for the slot-bypass tests. */
  indexLoaded?: (sourceId: string) => boolean;
  /**
   * Whether one source's page contents are in memory (default: the
   * page-contents memo). Injectable for the slot-bypass tests.
   */
  fullTextLoaded?: (sourceId: string) => boolean;
  /**
   * Starts loading the indexes (default: every source's). /health and /ready
   * call it while no index is loaded, so an instance a load balancer has taken
   * out of rotation still retries — at most once per failure memo.
   */
  loadIndexes?: () => void;
  /**
   * Starts downloading the documentation files that failed (default: those
   * sources' indexes and page contents). /health and /ready call it while any
   * file is failing, so an idle server recovers once the site does — at most
   * once per failure memo, however often it is probed — instead of reporting
   * "degraded" until the next search happens to load the file.
   */
  reloadFailing?: (failing: UpstreamFailure[]) => void;
}

/** A documentation file the server could not refresh from developer.magiclane.com. */
export interface UpstreamFailure extends FailingFile {
  part: 'index' | 'full-text';
}

function reloadFailedFiles(failing: UpstreamFailure[]): void {
  // No call waits for these: they queue behind the calls' fetches, a few at a
  // time, in the order of reloadOrder. Neither load rejects: a failure is
  // reported in the result (and in the memo).
  withRequestContext({ background: true }, () => {
    for (const file of reloadOrder(failing)) {
      void (file.part === 'index' ? loadIndex([file.source]) : loadFullTextSections([file.source]));
    }
  });
}

/**
 * The failed files in the order to reload them: those whose last download
 * hung (was sent and got no answer in time) after all the others, so a file
 * that keeps hanging does not take a background turn while files that failed
 * fast wait; within each group, the one whose download last got going
 * longest ago first (never: first of all). What counts is when a request was
 * really sent, which the memo notes (startedAt), not when a probe asked. A
 * file is known to hang only once it has hung: in the first round after the
 * failure memo, one that hangs hands its turn on after 5 s instead (see
 * backgroundHanging in utils/http-client.ts).
 */
export function reloadOrder(failing: UpstreamFailure[]): UpstreamFailure[] {
  const hung = (file: UpstreamFailure): number => (file.hung ? 1 : 0);
  return [...failing].sort((a, b) => hung(a) - hung(b) || (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

function defaultUpstreamFailures(): UpstreamFailure[] {
  return [
    ...failingIndexes().map((f) => ({ ...f, part: 'index' as const })),
    ...failingFullTexts().map((f) => ({ ...f, part: 'full-text' as const })),
  ];
}

export interface HttpApp {
  /** The `node:http` request listener. */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** Drop expired rate-limit windows; call periodically. */
  sweep: () => void;
  /** Live counters, for tests and diagnostics. */
  stats: () => {
    rateBuckets: number;
    /** MCP requests holding a concurrency slot (tool calls). */
    inFlightRequests: number;
    /** MCP requests being answered, the light ones (initialize, ping, the lists) included: what a drain waits for. */
    servingRequests: number;
    queuedRequests: number;
    inFlightBodyBytes: number;
    bodyClients: number;
    requestClients: number;
  };
  /** Stop accepting MCP work: /health and /ready answer 503 and new requests are refused. */
  close: () => void;
}

class BodyTooLargeError extends Error {}
class BodyTimeoutError extends Error {}
/** A body cut off to make room for another client's request (408, like a stalled one). */
class BodyCutError extends BodyTimeoutError {}

/** A request body being read: when it started, whose it is, and how to cut it off. */
interface BodyRead {
  startedAt: number;
  client: string;
  cut: (err?: Error) => void;
}
class BodyBudgetError extends Error {
  /** Whose budget ran out: the client's share, or the whole server's. */
  readonly scope: 'client' | 'server';
  constructor(scope: 'client' | 'server') {
    super(`${scope} body budget spent`);
    this.scope = scope;
  }
}

/**
 * Methods answered from memory, without the documentation host: they never
 * wait for a slot, so a saturated server still completes the handshake and
 * answers pings. (Notifications and responses carry no work either.)
 */
const LIGHT_METHODS = new Set([
  'initialize',
  'ping',
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
]);

/**
 * Tools that read nothing but documentation files the server holds in
 * memory: list_docs the llms.txt indexes, find_across_sdks every index and
 * every page-contents file (llms-full.txt, which it checks some pages'
 * text against). Once the files they need are in memory — every source's,
 * or the one a `list_docs` call names — they answer from it (a due refresh
 * goes through the outbound queue's high-priority lane, and a stale copy is
 * served meanwhile), so they need no request slot either.
 */
const IN_MEMORY_TOOLS = new Set(['list_docs', 'find_across_sdks']);

const SOURCE_IDS = DOCS.sources.map((s) => s.id);

function isLight(
  message: unknown,
  indexLoaded: (sourceId: string) => boolean,
  fullTextLoaded: (sourceId: string) => boolean
): boolean {
  const m = message as { method?: unknown; params?: { name?: unknown; arguments?: { source?: unknown } } } | null;
  const method = m?.method;
  if (typeof method !== 'string') return true; // a JSON-RPC response: no work
  if (method === 'tools/call') {
    if (!IN_MEMORY_TOOLS.has(m?.params?.name as string)) return false;
    // Only list_docs has a `source` parameter: find_across_sdks ignores a
    // stray one (unknown keys are dropped) and still reads every index.
    const source = m?.params?.name === 'list_docs' ? m?.params?.arguments?.source : undefined;
    const needed = typeof source === 'string' && SOURCE_IDS.includes(source) ? [source] : SOURCE_IDS;
    return needed.every(indexLoaded) && (m?.params?.name === 'list_docs' || needed.every(fullTextLoaded));
  }
  return LIGHT_METHODS.has(method) || method.startsWith('notifications/');
}

/** The rate-limit cost of one message: the tool's weight for tools/call, else 1. */
function costOf(message: unknown, costs: Readonly<Record<string, number>>): number {
  const m = message as { method?: unknown; params?: { name?: unknown } } | null;
  if (m?.method !== 'tools/call' || typeof m.params?.name !== 'string') return 1;
  return costs[m.params.name] ?? 1;
}

/** Declared body size up to which a request skips the server-wide body budget check. */
const TINY_BODY_BYTES = 1024;

/**
 * Under pressure (half the body budget in use), a body still arriving after
 * this long is cut off with 408, so slow bodies cannot keep the budget spent
 * for the full `bodyTimeoutMs` while other clients are refused.
 */
const STALLED_BODY_MS = 2_000;

/** How long a refusal for the body budget keeps /health and /ready "degraded". */
const BODY_REFUSAL_MEMO_MS = 10_000;

/**
 * Rate-limit windows kept at once, by default. Beyond it (after dropping
 * expired ones), the oldest window makes room for the new client: a flood of
 * distinct addresses cannot grow the table without bound, and cannot lock
 * new clients out either — at worst an evicted client starts a fresh window.
 */
const MAX_RATE_BUCKETS = 100_000;

/** How often, at most, a full rate-limit table is swept before evicting. */
const SWEEP_INTERVAL_MS = 1_000;

/** A request waiting for a slot. */
interface QueuedRequest {
  client: string;
  grant: () => void;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
}

function jsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {}
): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

/** The request target's path, without parsing it as a URL (which throws on `//[`). */
export function pathOf(target: string | undefined): string {
  const raw = target ?? '/';
  const end = raw.search(/[?#]/);
  const path = end === -1 ? raw : raw.slice(0, end);
  return path === '' ? '/' : path;
}

export function createHttpApp(options: HttpAppOptions): HttpApp {
  const { mcpPath, allowedHosts, dnsRebindingProtection, corsPolicy, limits, createServer } = options;
  const { trustedProxyHops, trustedProxies } = options;
  const now = options.now ?? Date.now;
  const upstreamFailures = options.upstreamFailures ?? defaultUpstreamFailures;
  const indexesLoaded = options.indexesLoaded ?? loadedIndexCount;
  const indexLoaded = options.indexLoaded ?? ((sourceId: string): boolean => peekIndex(sourceId) !== undefined);
  const fullTextLoaded =
    options.fullTextLoaded ?? ((sourceId: string): boolean => peekFullTextSections(sourceId) !== undefined);
  const loadIndexes = options.loadIndexes ?? ((): void => void loadIndex());
  const reloadFailing = options.reloadFailing ?? reloadFailedFiles;

  /** Fixed-window request counter per client key. */
  const rateBuckets = new Map<string, { count: number; windowStart: number }>();
  let inFlightRequests = 0;
  /** Requests being answered by a server/transport pair, slot or no slot (see serve). */
  let servingRequests = 0;
  /** Executing requests per client key (entries removed at zero). */
  const requestsByClient = new Map<string, number>();
  const queue: QueuedRequest[] = [];
  let inFlightBodyBytes = 0;
  /** Buffered body bytes per client key (entries removed at zero). */
  const bodyBytesByClient = new Map<string, number>();
  /** Bodies being read: when each started, and how to cut it off. */
  const bodyReads = new Set<BodyRead>();
  /** When a request was last refused for the server-wide body budget. */
  let bodyRefusedAt = Number.NEGATIVE_INFINITY;
  let lastSweepAt = Number.NEGATIVE_INFINITY;
  let closing = false;

  /**
   * Count `cost` requests against the client's window; false — and nothing
   * charged — when that would exceed the limit, so a refused call does not
   * shorten the client's window further.
   */
  function withinRateLimit(client: string, cost: number): boolean {
    const at = now();
    const key = bucketKey(client);
    let bucket = rateBuckets.get(key);
    if (!bucket || !withinLast(bucket.windowStart, limits.rateLimitWindowMs, at)) {
      bucket = { count: 0, windowStart: at };
      // Re-inserted, so the table stays in window order: the first entry
      // is always the oldest window, the one evicted when the table is full.
      rateBuckets.delete(key);
      rateBuckets.set(key, bucket);
    }
    if (bucket.count + cost > limits.rateLimitMax) return false;
    bucket.count += cost;
    return true;
  }

  const weighted = Object.entries(limits.toolCallCosts)
    .filter(([, cost]) => cost > 1)
    .map(([name, cost]) => `; a ${name} call counts ${cost}`)
    .join('');

  /**
   * The window a client counts in — always its own: when the table is full,
   * expired windows are swept (at most once a second, so a flood cannot make
   * every request scan the table), then the oldest window is evicted.
   */
  function bucketKey(client: string): string {
    const max = limits.maxRateBuckets ?? MAX_RATE_BUCKETS;
    if (rateBuckets.has(client) || rateBuckets.size < max) return client;
    // (A last sweep from before a backward clock step is not one within the second.)
    if (!withinLast(lastSweepAt, SWEEP_INTERVAL_MS, now())) sweep();
    if (rateBuckets.size >= max) rateBuckets.delete(rateBuckets.keys().next().value as string);
    return client;
  }

  /** 429, with Retry-After set to what is left of the client's window. */
  function rateLimited(res: ServerResponse, client: string): void {
    // withinRateLimit has just created or refreshed the client's bucket.
    const bucket = rateBuckets.get(client) as { windowStart: number };
    const left = bucket.windowStart + limits.rateLimitWindowMs - now();
    jsonRpcError(
      res,
      429,
      -32000,
      `Rate limit exceeded (${limits.rateLimitMax} requests per ${limits.rateLimitWindowMs / 1000}s${weighted})`,
      { 'Retry-After': String(Math.max(1, Math.ceil(left / 1000))) }
    );
  }

  function adjust(map: Map<string, number>, key: string, delta: number): void {
    const value = (map.get(key) ?? 0) + delta;
    if (value === 0) map.delete(key);
    else map.set(key, value);
  }

  function canRun(client: string): boolean {
    return (
      inFlightRequests < limits.maxConcurrentRequests &&
      (requestsByClient.get(client) ?? 0) < limits.maxConcurrentPerClient
    );
  }

  function take(client: string): void {
    inFlightRequests++;
    adjust(requestsByClient, client, 1);
  }

  /**
   * A slot for one request: at once when the server and the client's share
   * allow it, else after a short wait in a bounded queue. Resolves false when
   * the queue is full (or already holds the client's share), the wait times
   * out, or the client disconnects while waiting.
   */
  function acquireSlot(client: string, res: ServerResponse): Promise<boolean> {
    if (canRun(client)) {
      take(client);
      return Promise.resolve(true);
    }
    const queuedForClient = queue.filter((q) => q.client === client).length;
    if (queue.length >= limits.maxQueuedRequests || queuedForClient >= limits.maxConcurrentPerClient) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      const leave = (): void => {
        const at = queue.indexOf(entry);
        if (at === -1) return;
        queue.splice(at, 1);
        clearTimeout(timer);
        resolve(false);
      };
      const entry: QueuedRequest = {
        client,
        grant: () => {
          clearTimeout(timer);
          res.off('close', leave);
          take(client);
          resolve(true);
        },
      };
      const timer = setTimeout(leave, limits.queueWaitMs);
      res.once('close', leave);
      queue.push(entry);
    });
  }

  /** Free a slot and hand it to the first waiting request whose client is under its share. */
  function releaseSlot(client: string): void {
    inFlightRequests--;
    adjust(requestsByClient, client, -1);
    for (let i = 0; i < queue.length;) {
      const next = queue[i] as QueuedRequest;
      if (!canRun(next.client)) {
        i++;
        continue;
      }
      queue.splice(i, 1);
      next.grant();
    }
  }

  function setCommonHeaders(req: IncomingMessage, res: ServerResponse): void {
    // Responses are JSON-RPC or SSE for one client: never cache, never sniff.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const allowOrigin = resolveCorsAllowOrigin(req.headers.origin, corsPolicy);
    if (allowOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowOrigin);
      if (allowOrigin !== '*') res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, mcp-protocol-version');
  }

  /**
   * Buffer the body under four guards: the per-request cap, the client's and
   * the process-wide in-flight budgets — both charged as the bytes arrive, so
   * many slow bodies admitted at once cannot together exceed them — and a
   * deadline, so a client that sends slowly cannot hold memory for Node's
   * default five minutes. A tiny body is exempt from the server-wide budget
   * (Node's parser never lets it grow past its declared length).
   */
  async function readBody(req: IncomingMessage, client: string, tiny: boolean): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    // Bytes currently charged to the global and the client's budget; settled
    // exactly once, whether the read completes, overflows, times out or the
    // socket dies.
    let charged = 0;
    const settle = (): void => {
      inFlightBodyBytes -= charged;
      adjust(bodyBytesByClient, client, -charged);
      charged = 0;
    };
    const read = (async () => {
      try {
        for await (const chunk of req) {
          const length = (chunk as Buffer).length;
          size += length;
          inFlightBodyBytes += length;
          adjust(bodyBytesByClient, client, length);
          charged += length;
          if (size > limits.maxBodyBytes) throw new BodyTooLargeError();
          if ((bodyBytesByClient.get(client) as number) > limits.maxInFlightBodyBytesPerClient) {
            throw new BodyBudgetError('client');
          }
          if (!tiny && inFlightBodyBytes > limits.maxInFlightBodyBytes) {
            // The budget was not full when this body was admitted, but it is
            // now: those holding more than their share give way before this
            // body, within its own share, is refused.
            shedOverShare(client, 0, true);
            if (inFlightBodyBytes > limits.maxInFlightBodyBytes) throw new BodyBudgetError('server');
          }
          chunks.push(chunk as Buffer);
        }
      } finally {
        settle();
      }
    })();
    let timer: NodeJS.Timeout | undefined;
    let tracked: BodyRead | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new BodyTimeoutError()), limits.bodyTimeoutMs);
      const read: BodyRead = {
        startedAt: now(),
        client,
        // The budget is released at once, so the request that cut it off can use it.
        cut: (err = new BodyTimeoutError()) => {
          bodyReads.delete(read);
          settle();
          reject(err);
        },
      };
      tracked = read;
      bodyReads.add(read);
    });
    try {
      await Promise.race([read, deadline]);
    } catch (err) {
      // The 408/413 answer closes the connection. Release the budget now and
      // tear the half-read request down once the answer is out; the abandoned
      // read then ends with an "aborted" error nobody needs to hear about.
      settle();
      read.catch(() => {});
      // (An overflow has already torn the request down via the iterator's return;
      // a timeout has not, so free the half-read request once the answer is out.)
      req.socket?.once('close', () => req.destroy());
      throw err;
    } finally {
      clearTimeout(timer);
      bodyReads.delete(tracked as BodyRead);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw.length === 0 ? undefined : JSON.parse(raw);
  }

  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, client: string): Promise<void> {
    if (req.method !== 'POST') {
      // Stateless: there is no session to open a notification stream for or to delete.
      res.writeHead(405, { Allow: 'POST, OPTIONS' }).end();
      return;
    }
    // The call's page fetches end FETCH.requestBudgetMs after this, the waits for the body and a slot included.
    const endBy = Date.now() + FETCH.requestBudgetMs;
    // A tiny declared body (a ping, an initialize) is never what spends the
    // server-wide budget: only its client's share applies to it.
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (declared > limits.maxBodyBytes) {
      // Refused before it can take anything from the budget or cut anyone.
      jsonRpcError(res, 413, -32600, `Request body exceeds ${limits.maxBodyBytes} bytes`, { Connection: 'close' });
      return;
    }
    const tiny = declared > 0 && declared <= TINY_BODY_BYTES;
    // What this body will need: its declared length (at most maxBodyBytes,
    // checked above), or a single byte when the length is not declared.
    const needed = Math.max(1, declared || 1);
    if (!tiny && inFlightBodyBytes * 2 >= limits.maxInFlightBodyBytes) shedStalledBodies();
    // Not only when the budget is spent: one held a few bytes short of full
    // would otherwise admit the newcomer and refuse it half-way through.
    if (!tiny && inFlightBodyBytes + needed > limits.maxInFlightBodyBytes) shedOverShare(client, needed);
    if (!tiny && inFlightBodyBytes >= limits.maxInFlightBodyBytes) {
      bodyRefusedAt = now();
      jsonRpcError(res, 503, -32000, 'Server busy: request bodies in flight exceed the memory budget', {
        'Retry-After': '1',
      });
      return;
    }
    if ((bodyBytesByClient.get(client) ?? 0) >= limits.maxInFlightBodyBytesPerClient) {
      jsonRpcError(res, 503, -32000, 'Too many request bodies in flight from this client; retry shortly', {
        'Retry-After': '1',
      });
      return;
    }

    let body: unknown;
    try {
      body = await readBody(req, client, tiny);
    } catch (err) {
      if (err instanceof BodyBudgetError) {
        if (err.scope === 'server') bodyRefusedAt = now();
        const message =
          err.scope === 'client'
            ? 'Too many request bodies in flight from this client; retry shortly'
            : 'Server busy: request bodies in flight exceed the memory budget';
        jsonRpcError(res, 503, -32000, message, { 'Retry-After': '1', Connection: 'close' });
      } else if (err instanceof BodyTooLargeError) {
        // The unread remainder would poison the keep-alive connection: close it.
        jsonRpcError(res, 413, -32600, `Request body exceeds ${limits.maxBodyBytes} bytes`, { Connection: 'close' });
      } else if (err instanceof BodyCutError) {
        jsonRpcError(
          res,
          408,
          -32600,
          'Request body cut off: this client held more than its share of the body budget; retry',
          {
            Connection: 'close',
          }
        );
      } else if (err instanceof BodyTimeoutError) {
        jsonRpcError(res, 408, -32600, `Request body not received within ${limits.bodyTimeoutMs} ms`, {
          Connection: 'close',
        });
      } else {
        jsonRpcError(res, 400, -32700, 'Parse error: invalid JSON');
      }
      return;
    }

    // JSON-RPC batching was removed from the MCP protocol (2025-06-18); here it
    // would also let one request carry thousands of tool calls past the limiter.
    if (Array.isArray(body)) {
      jsonRpcError(
        res,
        400,
        -32600,
        'Batched (array) requests are not supported; send one JSON-RPC message per request'
      );
      return;
    }

    // An expensive call counts as several requests (the first was counted on arrival).
    const cost = costOf(body, limits.toolCallCosts);
    if (cost > 1 && !withinRateLimit(client, cost - 1)) {
      rateLimited(res, client);
      return;
    }

    if (isLight(body, indexLoaded, fullTextLoaded)) {
      await serve(req, res, body, client, endBy);
      return;
    }
    if (!(await acquireSlot(client, res))) {
      if (!res.writableEnded && !res.destroyed) {
        // Say whose limit it was: a client at its own share is told so, rather
        // than that the whole server is busy.
        const message =
          (requestsByClient.get(client) ?? 0) >= limits.maxConcurrentPerClient
            ? `Too many requests in progress from this client (${limits.maxConcurrentPerClient} at once); ` +
              'retry when one has finished'
            : 'Server busy: too many requests in progress; retry shortly';
        jsonRpcError(res, 503, -32000, message, { 'Retry-After': '1' });
      }
      return;
    }
    try {
      await serve(req, res, body, client, endBy);
    } finally {
      releaseSlot(client);
    }
  }

  /**
   * Cut off the bodies that have been arriving for longer than
   * STALLED_BODY_MS — one that started before a backward clock step among
   * them (see utils/clock.ts), not kept for the length of the step.
   */
  function shedStalledBodies(): void {
    const at = now();
    for (const read of [...bodyReads]) if (!withinLast(read.startedAt, STALLED_BODY_MS, at)) read.cut();
  }

  /**
   * `needed` more bytes would not fit the budget (or, `streaming`, the bytes
   * `client` has just received did not): every client with bodies in flight
   * is entitled to an equal share of the budget (the newcomer included), so
   * the bodies of those holding more than their share are cut, biggest holder
   * first and its oldest body first, until the request fits. Many clients
   * renewing their bodies faster than the stalled cut-off can keep the budget
   * full, or nearly full, between them, but not keep anyone else out of it.
   * A body that is itself over its share while streaming cuts nobody.
   */
  function shedOverShare(client: string, needed: number, streaming = false): void {
    const holders = new Set([...bodyBytesByClient.keys(), client]).size;
    const share = limits.maxInFlightBodyBytes / holders;
    if (streaming && (bodyBytesByClient.get(client) as number) > share) return;
    const over = [...bodyBytesByClient]
      .filter(([holder, bytes]) => holder !== client && bytes > share)
      .sort((a, b) => b[1] - a[1])
      .map(([holder]) => holder);
    for (const holder of over) {
      const reads = [...bodyReads].filter((r) => r.client === holder).sort((a, b) => a.startedAt - b.startedAt);
      for (const read of reads) {
        read.cut(new BodyCutError());
        if (inFlightBodyBytes + needed <= limits.maxInFlightBodyBytes) return;
      }
    }
  }

  /**
   * Answer one message with a fresh server/transport pair. Closing the
   * transport when the response closes aborts the tool calls in progress
   * (their fetches stop waiting); the promise settles only when that work has
   * finished, so a disconnecting client cannot free its slot early.
   */
  async function serve(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    client: string,
    endBy: number
  ): Promise<void> {
    const work: Array<Promise<unknown>> = [];
    servingRequests++;
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createServer();
      await server.connect(transport);
      // The transport writes the whole response before this resolves (JSON) or
      // streams it (SSE); either way the pair is torn down when the response ends.
      res.on('close', () => {
        void transport.close();
      });
      await withRequestContext({ client, endBy, track: (p) => work.push(p) }, () =>
        transport.handleRequest(req, res, body)
      );
      await Promise.allSettled(work);
    } finally {
      servingRequests--;
    }
  }

  function handler(req: IncomingMessage, res: ServerResponse): void {
    try {
      setCommonHeaders(req, res);

      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }

      // DNS-rebinding protection: reject a Host header that isn't on the allowlist.
      if (!isHostAllowed(req.headers.host, allowedHosts, dnsRebindingProtection)) {
        jsonRpcError(res, 403, -32000, hostRejectionMessage(req.headers.host));
        return;
      }

      // Refuse cross-origin browser requests unless the origin is allowlisted.
      if (!isOriginAllowed(req.headers.origin, corsPolicy)) {
        jsonRpcError(res, 403, -32000, originRejectionMessage(req.headers.origin as string));
        return;
      }

      const path = pathOf(req.url);
      const probe = path === '/health' || path === '/ready';

      // One rate-limit gate for every route. The probes count in a window of
      // their own per client: a load balancer or an orchestrator that polls
      // them through the same proxy as the MCP traffic is not refused when
      // the team is busy, and its polling does not use up the team's calls.
      const ip = clientIpFrom(
        req.socket.remoteAddress,
        req.headers['x-forwarded-for'],
        trustedProxyHops,
        trustedProxies
      );
      const client = rateLimitKey(ip);
      const window = probe ? `${client} (probes)` : client;
      if (!withinRateLimit(window, 1)) {
        rateLimited(res, window);
        return;
      }

      if (probe) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' }).end();
          return;
        }
        // Both answer the same body; they differ in what turns them 503.
        //
        // /health is the LIVENESS probe (the Docker HEALTHCHECK): 503 only
        // while shutting down. Load never fails it — a busy server that a
        // probe marks unhealthy gets restarted, which drops its caches and
        // only adds to the load — and neither does an unreachable docs site,
        // which no restart fixes.
        //
        // /ready is the READINESS probe (for a load balancer): additionally
        // 503 "saturated" while the request queue is full, so traffic goes
        // elsewhere until it drains, 503 "starting" until the first
        // documentation index has loaded (the probe starts that load), and
        // 503 "unavailable" while none is loaded and loading one fails, so an
        // instance that cannot answer gets no traffic. "degraded" (200 on both): still
        // serving, but every slot is busy, the outbound queue is full, the
        // body budget is spent or refused a request in the last 10 s, or
        // documentation files cannot be refreshed from developer.magiclane.com
        // (until they load again; a download hanging for over 5 s counts) —
        // `upstream` says which, and whether an older copy is served meanwhile.
        const outbound = fetchQueueStats();
        const failing = upstreamFailures();
        const saturated = queue.length >= limits.maxQueuedRequests;
        const noIndex = indexesLoaded() === 0;
        const unavailable = noIndex && failing.some((f) => f.part === 'index');
        const starting = noIndex && !unavailable;
        if (noIndex) loadIndexes();
        else if (failing.length > 0) reloadFailing(failing);
        const reasons: string[] = [];
        if (unavailable) reasons.push('no documentation index loaded: searches and listings cannot be answered');
        if (starting) reasons.push('no documentation index loaded yet: loading');
        if (saturated) reasons.push('request queue full');
        if (inFlightRequests >= limits.maxConcurrentRequests) reasons.push('all request slots busy');
        if (outbound.queued >= outbound.maxQueued) reasons.push('outbound fetch queue full');
        if (
          inFlightBodyBytes >= limits.maxInFlightBodyBytes ||
          withinLast(bodyRefusedAt, BODY_REFUSAL_MEMO_MS, now())
        ) {
          reasons.push('request body budget spent');
        }
        if (fetchesHanging()) {
          reasons.push(
            'developer.magiclane.com is hanging: a fetch has run over 5 s, or one timed out within the last 60 s'
          );
        }
        if (failing.length > 0) {
          reasons.push(
            `documentation files not refreshed from developer.magiclane.com: ` +
              failing.map((f) => `${f.source} ${f.part} (serving ${f.serving})`).join(', ')
          );
        }
        const status = closing
          ? 'shutting_down'
          : saturated
            ? 'saturated'
            : unavailable
              ? 'unavailable'
              : starting
                ? 'starting'
                : reasons.length > 0
                  ? 'degraded'
                  : 'ok';
        const down = closing || (path === '/ready' && (saturated || unavailable || starting));
        sendJson(res, down ? 503 : 200, {
          status,
          ...(reasons.length > 0 ? { reasons } : {}),
          server: SERVER_NAME,
          version: SERVER_VERSION,
          inFlightRequests,
          queuedRequests: queue.length,
          maxConcurrentRequests: limits.maxConcurrentRequests,
          inFlightBodyBytes,
          outbound,
          // What is failing and what is served meanwhile; when a download
          // last started is the reload order's business, not a reader's.
          upstream: {
            failing: failing.map(({ source, part, reason, serving }) => ({ source, part, reason, serving })),
          },
          cache: cacheStats(),
          fullText: fullTextStats(),
        });
        return;
      }

      if (path === mcpPath) {
        if (closing) {
          jsonRpcError(res, 503, -32000, 'Server is shutting down', { Connection: 'close' });
          return;
        }
        handleMcpRequest(req, res, client).catch((err: unknown) => {
          console.error('Error handling MCP request:', err);
          if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
          else res.end();
        });
        return;
      }

      // The default endpoint is named, to help; one set with MCP_HTTP_PATH is
      // not, so an unlisted path is not given away to whoever asks.
      sendJson(res, 404, { error: mcpPath === '/mcp' ? 'Not found. MCP endpoint is /mcp' : 'Not found' });
    } catch (err) {
      // A malformed request must never leave the socket hanging: answer and move on.
      console.error('Error routing request:', err);
      if (!res.headersSent) jsonRpcError(res, 400, -32600, 'Bad Request', { Connection: 'close' });
      else res.end();
    }
  }

  function sweep(): void {
    const at = now();
    lastSweepAt = at;
    for (const [key, bucket] of rateBuckets) {
      if (!withinLast(bucket.windowStart, limits.rateLimitWindowMs, at)) rateBuckets.delete(key);
    }
    sweepFetchBudgets();
  }

  return {
    handler,
    sweep,
    stats: () => ({
      rateBuckets: rateBuckets.size,
      inFlightRequests,
      servingRequests,
      queuedRequests: queue.length,
      inFlightBodyBytes,
      bodyClients: bodyBytesByClient.size,
      requestClients: requestsByClient.size,
    }),
    close: () => {
      closing = true;
    },
  };
}
