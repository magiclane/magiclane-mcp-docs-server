/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Compile-time configuration: every fixed value the server runs on, grouped
 * into frozen dictionaries by concern. Nothing here reads the environment —
 * that belongs in `./env.ts`, which layers overrides on top of these defaults.
 */

import { SERVER_NAME, SERVER_VERSION } from '../version.js';

/* -------------------------------------------------------------------------- */
/* Documentation source of truth                                               */
/* -------------------------------------------------------------------------- */

export interface DocSource {
  /** Stable identifier used in tool parameters. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** URL of the llms.txt index for this source. */
  indexUrl: string;
  /** Optional URL of the llms-full.txt (full page contents) for this source. */
  fullTextUrl?: string;
  /**
   * Title of the page that presents the source itself: the answer when a
   * question is about the platform rather than a topic of it ("what is
   * flutter", "ios vs android"). None for the cross-SDK developer guides.
   */
  overviewTitle?: string;
}

const BASE_URL = 'https://developer.magiclane.com';

/**
 * Known Magic Lane documentation sources exposing llms.txt indexes. This list
 * drives the `source` enums of every tool, the MCP resources, and the test
 * fixtures — adding an SDK is one entry here.
 */
const DOC_SOURCES: DocSource[] = [
  {
    // The site's "Developer" docs project: its llms.txt at /docs/, its pages
    // under /docs/guides/.
    id: 'developer',
    name: 'Magic Lane Guides (account, Map Studio, MCP Server)',
    indexUrl: `${BASE_URL}/docs/llms.txt`,
    fullTextUrl: `${BASE_URL}/docs/llms-full.txt`,
  },
  {
    id: 'flutter',
    name: 'Magic Lane Maps SDK for Flutter',
    indexUrl: `${BASE_URL}/docs/flutter/llms.txt`,
    fullTextUrl: `${BASE_URL}/docs/flutter/llms-full.txt`,
    overviewTitle: 'Maps SDK for Flutter',
  },
  {
    id: 'android',
    name: 'Magic Lane Maps SDK for Android',
    indexUrl: `${BASE_URL}/docs/android/llms.txt`,
    fullTextUrl: `${BASE_URL}/docs/android/llms-full.txt`,
    overviewTitle: 'Maps SDK for Android',
  },
  {
    id: 'ios',
    name: 'Magic Lane Maps SDK for iOS',
    indexUrl: `${BASE_URL}/docs/ios/llms.txt`,
    fullTextUrl: `${BASE_URL}/docs/ios/llms-full.txt`,
    overviewTitle: 'Maps SDK for iOS',
  },
  {
    id: 'cpp',
    name: 'Magic Lane Maps SDK for C++',
    indexUrl: `${BASE_URL}/docs/cpp/llms.txt`,
    fullTextUrl: `${BASE_URL}/docs/cpp/llms-full.txt`,
    overviewTitle: 'Maps SDK for C++',
  },
  {
    id: 'typescript',
    name: 'Magic Lane Maps SDK for TypeScript',
    indexUrl: `${BASE_URL}/docs/typescript/llms.txt`,
    fullTextUrl: `${BASE_URL}/docs/typescript/llms-full.txt`,
    overviewTitle: 'Maps SDK for TypeScript',
  },
  {
    id: 'cloud-rest-api',
    name: 'Magic Lane Cloud REST APIs (Routing, Isochrones, Search, Reverse Geocoding, Fleet Management, Geofences, Vector Tiles, Offline Maps)',
    indexUrl: `${BASE_URL}/docs/cloud-rest-api/llms.txt`,
    fullTextUrl: `${BASE_URL}/docs/cloud-rest-api/llms-full.txt`,
    overviewTitle: 'Cloud REST APIs',
  },
];

/**
 * The documentation this server serves, and the ONLY origin it may fetch from.
 * `host` is the single-host allowlist enforced by {@link isAllowedDocUrl}.
 */
export const DOCS = {
  baseUrl: BASE_URL,
  host: 'developer.magiclane.com',
  sources: DOC_SOURCES,
} as const;

/**
 * Outbound fetch policy. A URL is fetchable only when it is HTTPS, points at
 * exactly {@link DOCS.host} — not merely some `*.magiclane.com` subdomain, and
 * never cleartext HTTP — on the default port, and carries no credentials. This
 * is the single gate applied both when a user-supplied reference is normalized
 * and when a redirect target is followed. It lives beside the allowlist it
 * enforces so the two can never drift apart.
 */
export function isAllowedDocUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname.toLowerCase() === DOCS.host &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === ''
  );
}

/* -------------------------------------------------------------------------- */
/* Outbound HTTP                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The shared outbound fetch pipeline. `userAgent` is derived from package.json
 * — never hardcoded: the scoped package name is flattened into a single token,
 * so "@magiclane/mcp-docs-server" becomes "magiclane-mcp-docs-server".
 */
export const FETCH = {
  /**
   * The most one outbound fetch waits for each thing, timed separately: for
   * an outbound slot (counted from when it is queued) and for the host's
   * answer (counted from when the attempt starts), so a page queued behind
   * other readers is not timed out before it has started.
   */
  timeoutMs: 20_000,
  /**
   * The most one outbound fetch takes in all, from queueing to the last byte,
   * the slot wait and the single retry included: a hanging or slowly failing
   * host costs at most this, well inside the 60 s most MCP clients wait for a
   * tool call (the pages of a large batch: FETCH.batchTimeoutMs). The outage
   * memo and the stale copies cover the host afterwards.
   */
  overallTimeoutMs: 30_000,
  /** Delay before the single retry of a transient (network/5xx) failure. */
  retryDelayMs: 250,
  /** Maximum number of redirect hops followed for a single fetch. */
  maxRedirects: 3,
  /** Maximum bytes accepted for a single response (memory guard). */
  maxResponseBytes: 10 * 1024 * 1024,
  /**
   * Maximum outbound requests in flight at once, across every tool call — plus
   * one while a client holds a slot it borrowed when it was alone, for a
   * client running nothing yet, and one for each background reload that has
   * handed its turn on (see capacity() in http-client.ts). One batched MCP
   * request could otherwise fan out into hundreds of page fetches against
   * the documentation host.
   */
  maxConcurrent: 6,
  /**
   * Page fetches allowed to wait for a slot; beyond this a page fetch is
   * refused at once ("busy, retry"). The index and full-text files are exempt
   * and jump the queue.
   */
  maxQueued: 64,
  /** Page fetches one HTTP client may have waiting at once — its share of the queue above. */
  maxQueuedPerClient: 16,
  /**
   * Page fetches one HTTP client may have running at once while other
   * clients wait: the rest of the outbound slots stay free for others, so one
   * client whose pages hang upstream cannot hold them all. Alone, a client
   * also uses the idle slots — all but one, which is always kept for a client
   * running nothing yet, as it is while fewer than three clients run pages.
   * The index and full-text files, and the stdio server (one user, no
   * client), are exempt.
   */
  maxActivePerClient: 4,
  /**
   * Shared files reloaded at once with no call waiting for them (the health
   * probes' retries of failed files): they go after every call's fetches and
   * always leave a slot free, so a hanging site cannot make them hold every
   * slot. Each waits up to FETCH.overallTimeoutMs (30 s) for a slot and takes
   * at most 50 s in all (that plus FETCH.timeoutMs). One that has had no
   * answer for FETCH.slowFetchMs hands its turn to the next file and runs on
   * beside the slots (this many at most), so files that hang do not keep the
   * others waiting for their 20 s.
   */
  maxBackgroundFetches: 2,
  /**
   * A fetch holding its slot longer than this means the site is hanging, at
   * least for some pages: the last free slot is then kept for a client
   * running nothing yet, and a background reload with no answer by then
   * hands its turn on (see FETCH.maxBackgroundFetches).
   */
  slowFetchMs: 5_000,
  /**
   * How long a fetch that timed out waiting for the site's answer is
   * remembered: /health says "degraded" until the site answers a fetch again
   * or this passes, and the slot rule keeps the last free slot for a client
   * running nothing yet for all of it (see siteHanging() in http-client.ts).
   */
  hangMemoMs: 60_000,
  /**
   * The least time a fetch that gets its slot must have left — before its
   * overall limit, and before the last of the calls waiting for it stops
   * waiting (FETCH.requestBudgetMs) — to be sent at all: with less, the
   * request would be aborted as soon as it went out, so the slot goes to
   * another fetch and this one fails as one that never got a slot, charged
   * to nobody's page budget. A fetch that is sent is charged, whether or not
   * its callers stay for the answer.
   */
  minAttemptMs: 1_000,
  /**
   * How long the pages of one read_docs_batch call may take in all, from
   * queueing: a batch's pages wait their turn for a slot together, so the
   * later ones may wait longer than one page would (FETCH.timeoutMs for each
   * round of FETCH.maxActivePerClient pages), up to this. Only a batch of more
   * than one round. Over HTTP, FETCH.requestBudgetMs makes the call stop
   * waiting sooner when the request waited for its slot — and longer when it
   * did not: the pages then wait and run until the call stops waiting, as
   * under load (their turns go round-robin with other clients' pages) a
   * batch's last pages get their turn late while the call has time for them.
   */
  batchTimeoutMs: 50_000,
  /**
   * When an HTTP call stops waiting for its pages at the latest, from the
   * moment its request arrived: the wait for a request slot (up to 10 s)
   * included, so a large batch on a busy server still answers inside the 60 s
   * most MCP clients wait for a tool call — the pages not fetched by then are
   * reported, the others returned. It is the caller's own limit: a page
   * download shared with other calls goes on for them on the fetch's own
   * limits, a late call leaving it is not a failure of the site, and a
   * download every caller left is aborted. It never cuts a download short,
   * but a batch's pages may run until it (see FETCH.batchTimeoutMs).
   */
  requestBudgetMs: 55_000,
  /** How long a 404 (or other 4xx) is remembered so repeats are not re-fetched. */
  negativeTtlMs: 60_000,
  /**
   * Remembered failures kept at once (by URL): beyond this the oldest are
   * dropped, so a stream of references to pages that do not exist cannot grow
   * the process without bound.
   */
  maxNegativeEntries: 10_000,
  /**
   * How long an unreachable host (timeout, 5xx, network error) is remembered
   * per URL: during an outage each call answers at once — from the stale copy
   * when there is one — instead of waiting for another timeout.
   */
  failureMemoMs: 30_000,
  /**
   * With a stale copy at hand, how long a refresh is waited for before the
   * stale copy is served (the refresh still completes in the background).
   */
  staleGraceMs: 5_000,
  /**
   * Uncached page fetches one HTTP client may start per window. Cached pages
   * and the shared index/full-text files do not count; stdio has no limit.
   */
  perClientMaxFetches: 120,
  perClientWindowMs: 60_000,
  /**
   * Clients whose fetch budgets are kept at once: like the rate-limit table,
   * the oldest window makes room when it is full, so a flood of addresses
   * cannot grow the map without bound between the 60 s sweeps.
   */
  maxBudgetClients: 100_000,
  userAgent: `${SERVER_NAME.replace(/^@/, '').replace(/\//g, '-')}/${SERVER_VERSION}`,
} as const;

/**
 * The shared page cache (least-recently-used, bounded by age, entry count AND
 * total bytes). The llms.txt indexes and llms-full.txt sections are memoized
 * separately in the docs layer, so user-chosen page URLs can never push them
 * out of memory.
 */
export const CACHE = {
  /** Cache TTL for fetched documents and indexes (1 hour). */
  ttlMs: 60 * 60 * 1000,
  /** Maximum entries kept (memory guard). */
  maxEntries: 200,
  /** Maximum total bytes kept (memory guard). */
  maxBytes: 5 * 1024 * 1024,
  /** Largest single body kept; a bigger one (a whole llms-full.txt) is served but not cached. */
  maxEntryBytes: 512 * 1024,
} as const;

/* -------------------------------------------------------------------------- */
/* Tool response limits                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Caps on what a single tool call may accept, pull in or hand back. The input
 * caps matter for availability: search cost grows with the number of query
 * words × pages, and the trailing-slash trim grows with reference length, so
 * an unbounded argument could stall the single-threaded process from one call.
 * The output caps keep one call from filling the model's context — the
 * largest page is ~270k characters (~67k tokens).
 */
export const LIMITS = {
  /** Maximum number of documents in one read_docs_batch call. */
  maxBatchSize: 20,
  /**
   * Values (array elements and object keys) one tool call's arguments may
   * hold, counted before validation: a read_docs_batch array far over its 20
   * URLs is refused at once instead of getting one error line per element
   * (255 empty strings already draw a 14,000-character answer), while one a
   * little over (21 to 255 URLs, the batch a model most often makes too big)
   * still gets the schema's own answer, the 20-URL limit. The SDK writes the
   * refusal, which names this cap and not the 20 URLs: the tool's description
   * says so.
   */
  maxToolInputElements: 256,
  /** Maximum length of a free-text query. */
  maxQueryChars: 300,
  /** Maximum number of distinct words scored from one query. */
  maxQueryTokens: 16,
  /** Maximum length of a page URL / documentation path argument. */
  maxRefChars: 500,
  /** Maximum length of short filter arguments (language tag, section name). */
  maxFilterChars: 64,
  /** Characters of one page read_doc returns by default (get_code_examples: maxCodeExampleChars). */
  defaultDocumentChars: 24_000,
  /**
   * Hard maximum characters one call returns for one page (read_doc slice,
   * get_code_examples budget, one product-guide section): ~12k tokens.
   */
  maxDocumentChars: 50_000,
  /** Total character budget of one read_docs_batch response. */
  maxBatchChars: 120_000,
  /**
   * Characters of code get_code_examples returns by default (its output
   * budget; the whole page is scanned for blocks).
   */
  maxCodeExampleChars: 24_000,
  /**
   * Pages in one list_docs "pages" response by default, and at most (page
   * through with offset). 50 index entries are ~12k characters; the largest
   * source (Flutter, 182 pages) takes four calls.
   */
  defaultListPages: 50,
  maxListPages: 100,
} as const;

/* -------------------------------------------------------------------------- */
/* Streamable HTTP transport                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Fixed limits of the Streamable HTTP transport. The tunable parts of that
 * transport (port, host, path, CORS, Host allowlist, proxy hops) are
 * environment-driven and live in `./env.ts`.
 */
export const HTTP = {
  /** Maximum accepted JSON-RPC request body size (one tool call is < 1 KB). */
  maxBodyBytes: 256 * 1024,
  /** Total request-body bytes that may be buffered at once across all connections. */
  maxInFlightBodyBytes: 16 * 1024 * 1024,
  /** Request-body bytes one client may have buffered at once (four maximal bodies). */
  maxInFlightBodyBytesPerClient: 1024 * 1024,
  /** Time allowed to receive a complete request body before answering 408. */
  bodyTimeoutMs: 15_000,
  /**
   * Maximum MCP requests executed concurrently (tool calls share one event
   * loop). Eight clients at their full per-client share, so a handful of
   * clients stuck on a hanging docs site do not take every slot.
   */
  maxConcurrentRequests: 32,
  /** Maximum MCP requests one client executes concurrently — its share of the above. */
  maxConcurrentPerClient: 4,
  /** Requests that may wait for a free slot; beyond this they are answered 503. */
  maxQueuedRequests: 64,
  /** How long a request waits for a free slot before it is answered 503. */
  queueWaitMs: 10_000,
  /** Max requests per client within the rate-limit window. */
  rateLimitMax: 300,
  /** Rate-limit window length. */
  rateLimitWindowMs: 60_000,
  /**
   * What one call of a tool counts against the rate limit. The searches scan
   * every index and ~9 MB of page text, so they cost several plain requests.
   */
  toolCallCosts: { search_docs: 5, find_across_sdks: 5 },
  /** Socket timeouts handed to node:http (slow-loris protection). */
  headersTimeoutMs: 15_000,
  requestTimeoutMs: 60_000,
  socketIdleTimeoutMs: 120_000,
  keepAliveTimeoutMs: 5_000,
  /**
   * How often the listener checks the header and request timeouts above:
   * Node's default (30 s) would let unfinished headers live 15 to 45 s.
   */
  connectionsCheckingIntervalMs: 1_000,
  /**
   * On SIGTERM or SIGINT, how long calls already running may finish before
   * the process exits anyway (with status 1): below the 10 s `docker stop`
   * waits before it kills the container.
   */
  shutdownGraceMs: 8_000,
} as const;

/** Fixed limits of the stdio transport. */
export const STDIO = {
  /**
   * When the client closes stdin, the calls still running finish and their
   * results go out first, so a one-shot pipe (requests, then EOF) gets every
   * answer: each request the documentation site was sent is waited for on
   * its own limits — its first byte may take up to FETCH.timeoutMs — and a
   * site that keeps sending keeps the calls running. The first request the
   * site leaves unanswered for FETCH.timeoutMs stops the sending (a hanging
   * page would otherwise keep a killed client's server alive for
   * FETCH.batchTimeoutMs, fetching): no further request goes out, and the
   * calls answer with what they have. With nothing to wait for from the site
   * for this long — no request within its own limits, no byte — the calls
   * still running are given up, and the process exits with status 1.
   */
  closeGraceMs: 3_000,
} as const;
