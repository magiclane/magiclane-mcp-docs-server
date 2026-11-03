/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The one outbound HTTP pipeline. Every byte this server fetches goes through
 * `doFetch`, which enforces the host allowlist on every redirect hop, a
 * timeout, a response size cap, a global concurrency cap with a bounded
 * queue, and refuses HTML (the docs site answers unknown paths with its HTML
 * shell, never an error).
 *
 * Fetches made for an MCP request follow that request (see
 * ./request-context.ts): a cancelled request stops waiting at once and leaves
 * the queue, and an HTTP client has its own budget of uncached page fetches,
 * so one client cannot keep the documentation host — and every other client's
 * fetches — busy.
 */

import { CACHE, DOCS, FETCH, isAllowedDocUrl } from '../config/constants.js';
import { stillAhead, withinLast } from './clock.js';
import { currentRequest, RequestCancelledError, unlessCancelled } from './request-context.js';
import type { RequestContext } from './request-context.js';

/** HTTP cache validators (ETag / Last-Modified) attached to a fetched body. */
export interface CacheValidators {
  etag?: string;
  lastModified?: string;
}

interface CacheEntry extends CacheValidators {
  body: string;
  bytes: number;
  fetchedAt: number;
}

/** Result of a conditional fetch: fresh content, or confirmation nothing changed. */
export type ConditionalResult =
  { status: 'fresh'; body: string; validators: CacheValidators } | { status: 'unchanged' };

/** Least-recently-used page cache: a `get` moves the entry to the end. */
const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;

/**
 * Remembered failures, by URL: 4xx and HTML answers for `FETCH.negativeTtlMs`,
 * and an unreachable host (timeout, 5xx, network error) for
 * `FETCH.failureMemoMs`, so an outage does not make every call wait again.
 * Bounded: expired entries go with the HTTP sweep, and the map holds at most
 * `FETCH.maxNegativeEntries`, oldest dropped first (insertion order).
 */
const negative = new Map<string, { until: number; message: string; permanent: boolean }>();

/** Remember a failed URL, making room by dropping the oldest entry when the memo is full. */
function rememberFailure(url: string, until: number, message: string, permanent: boolean): void {
  negative.delete(url); // re-inserted at the end: the newest
  if (negative.size >= FETCH.maxNegativeEntries) {
    const oldest = negative.keys().next().value as string;
    negative.delete(oldest);
  }
  negative.set(url, { until, message, permanent });
}

/** Drop the remembered failures that have expired; called with the HTTP rate-limit sweep. */
export function sweepFailureMemo(now: number = Date.now()): void {
  for (const [url, failure] of negative) if (!stillAhead(failure.until, LONGEST_MEMO_MS, now)) negative.delete(url);
}

/** The furthest ahead a failure memo is ever set: past that, the clock was stepped back since (see utils/clock.ts). */
const LONGEST_MEMO_MS = Math.max(FETCH.negativeTtlMs, FETCH.failureMemoMs);

/**
 * One shared download per URL. It runs on the fetch's own limits, never on a
 * caller's: each caller stops waiting on its own — cancelled, or out of its
 * request's time (`endBy`) — and the download goes on for the others.
 * `callers` are those still waiting for it, each with when its request stops
 * waiting; when every caller has left, nobody needs the download any more
 * and it is aborted — and a slot that comes when no caller has the time for
 * a request is not used (see FETCH.minAttemptMs).
 */
interface SharedFetch {
  promise: Promise<string>;
  controller: AbortController;
  callers: Set<Caller>;
}
/** A caller waiting for a shared download: when its request stops waiting (ms since epoch; Infinity without a deadline). */
interface Caller {
  endBy: number;
}
const inFlight = new Map<string, SharedFetch>();

/** When the last of the callers still waiting for a download stops waiting. */
function wantedUntil(shared: SharedFetch): number {
  let until = Number.NEGATIVE_INFINITY;
  for (const caller of shared.callers) until = Math.max(until, caller.endBy);
  return until;
}

/** Marker for upstream failures that are worth one retry (5xx). */
class TransientError extends Error {}

/**
 * A fetch that got no answer in time. Transient, but never retried: the host
 * is hanging. `cutShort` when the attempt was ended by the fetch's overall
 * limit before the host had its full FETCH.timeoutMs: that says less about
 * the host, and is not remembered as its failure.
 */
class FetchTimeoutError extends TransientError {
  constructor(
    message: string,
    readonly cutShort = false
  ) {
    super(message);
  }
}

/**
 * A caller stopped waiting for a page because its request ran out of time
 * (RequestContext.endBy). Its own deadline, not the site's failure: the
 * shared download goes on for the others, and nothing is remembered.
 */
export class FetchDeadlineError extends Error {}

/**
 * The site asked us to slow down or come back later (408, 429): transient,
 * but not retried at once, and remembered for its Retry-After (at most
 * FETCH.failureMemoMs) — never taken for a missing page.
 */
class SlowDownError extends TransientError {
  constructor(
    message: string,
    /** How long the site asked to be left alone, when it said (Retry-After). */
    readonly retryAfterMs: number | undefined
  ) {
    super(message);
  }
}

/** A Retry-After value (seconds, or an HTTP date) in ms from now; undefined when absent or unreadable. */
export function retryAfterMs(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  if (/^\s*\d+\s*$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * How long a failure of the site is remembered: FETCH.failureMemoMs, or the
 * site's own Retry-After when it asked to slow down, capped at that.
 */
export function failureMemoFor(err: unknown): number {
  const asked = err instanceof SlowDownError ? err.retryAfterMs : undefined;
  return asked === undefined ? FETCH.failureMemoMs : Math.min(asked, FETCH.failureMemoMs);
}

/**
 * Marker for answers that will not change by retrying: 4xx (but 408 and
 * 429), HTML, an empty page, a body over the size cap, and a redirect that
 * cannot be followed. Remembered for FETCH.negativeTtlMs.
 */
class PermanentError extends Error {}

/**
 * Whether a failed fetch says something about the site, so it is worth
 * remembering for a while (the 30 s outage memo): an answer that will not
 * change (4xx), or a host that was asked (`started`) and failed — not a
 * fetch that never got an outbound slot, nor an attempt the fetch's own
 * overall limit cut short before the host had its full FETCH.timeoutMs.
 * The page cache and the index/full-text memo use this one rule.
 */
export function isSiteFailure(err: unknown, started: boolean): boolean {
  if (err instanceof PermanentError) return true;
  return started && isTransientFailure(err) && !(err instanceof FetchTimeoutError && err.cutShort);
}

/**
 * Whether a page failed for want of time or room on this server — no
 * answer in time, or a full outbound queue — rather than because of the
 * page: asking again shortly may well succeed.
 */
export function isLoadFailure(err: unknown): boolean {
  return err instanceof FetchTimeoutError || err instanceof FetchBusyError || err instanceof FetchDeadlineError;
}

/**
 * Whether a fetch ran out of time — waiting for an outbound slot, or, once
 * started, for the site's answer (the site hung for it) — rather than being
 * refused or failing fast.
 */
export function isTimeout(err: unknown): boolean {
  return err instanceof FetchTimeoutError;
}

/** The outbound queue is full: refused at once rather than queued without bound. */
export class FetchBusyError extends Error {}

/** One HTTP client used up its budget of uncached page fetches. */
export class FetchBudgetError extends Error {}

/** Uncached page fetches started per HTTP client in the current window. */
const budgets = new Map<string, { count: number; windowStart: number }>();
let maxBudgetClients: number = FETCH.maxBudgetClients;

/** Exposed for tests: the clients whose budgets are kept at once (FETCH.maxBudgetClients otherwise). */
export function limitFetchBudgetClients(max: number = FETCH.maxBudgetClients): void {
  maxBudgetClients = max;
}

/** How many clients have a fetch budget window open, for tests and diagnostics. */
export function fetchBudgetClients(): number {
  return budgets.size;
}

/**
 * Reserve one fetch of a client's budget when the fetch is queued, or refuse
 * the client that has used it up. Reserving at once means fetches queued
 * together cannot all pass the check and overshoot the budget; a fetch that
 * never starts — refused as busy, timed out while waiting or cancelled —
 * gives its reservation back (see refundOutboundBudget).
 */
function reserveOutboundBudget(client: string | undefined): void {
  if (client === undefined) return; // stdio: the only client is the user's own process
  const now = Date.now();
  const budget = budgets.get(client);
  if (!budget || !withinLast(budget.windowStart, FETCH.perClientWindowMs, now)) {
    // Re-inserted, so the map stays in window order: the first entry is the
    // oldest window, the one that makes room when the map is full.
    budgets.delete(client);
    if (budgets.size >= maxBudgetClients) budgets.delete(budgets.keys().next().value as string);
    budgets.set(client, { count: 1, windowStart: now });
    return;
  }
  if (budget.count >= FETCH.perClientMaxFetches) {
    const retryIn = Math.ceil((budget.windowStart + FETCH.perClientWindowMs - now) / 1000);
    throw new FetchBudgetError(
      `Too many uncached documentation pages requested by this client (${FETCH.perClientMaxFetches} per ` +
        `${FETCH.perClientWindowMs / 1000} s); retry in ${retryIn} s. Pages already read stay available.`
    );
  }
  budget.count += 1;
}

/**
 * Give back the reservation of a fetch that never started (in the window it
 * was taken from); a window with nothing left in it goes, so clients whose
 * every fetch was refused leave nothing behind.
 */
function refundOutboundBudget(client: string, reservedAt: number): void {
  const budget = budgets.get(client);
  if (budget === undefined || budget.windowStart > reservedAt) return;
  budget.count -= 1;
  if (budget.count <= 0) budgets.delete(client);
}

/** Drop expired per-client fetch budgets and remembered failures; called with the HTTP rate-limit sweep. */
export function sweepFetchBudgets(): void {
  const now = Date.now();
  for (const [client, budget] of budgets) {
    if (!withinLast(budget.windowStart, FETCH.perClientWindowMs, now)) budgets.delete(client);
  }
  sweepFailureMemo(now);
}

/**
 * Fetch a URL as text through the shared pipeline: in-memory LRU cache with
 * ETag/Last-Modified revalidation (expired entries are refreshed with a cheap
 * 304 when upstream supports it), negative caching of 4xx answers, a request
 * timeout, one retry on transient failures, a response size cap, and
 * in-flight de-duplication.
 */
export async function fetchText(url: string): Promise<string> {
  const request = currentRequest();
  const now = Date.now();
  const cached = cache.get(url);
  if (cached && withinLast(cached.fetchedAt, CACHE.ttlMs, now)) {
    touch(url, cached);
    return cached.body;
  }

  const failed = negative.get(url);
  if (failed) {
    if (stillAhead(failed.until, LONGEST_MEMO_MS, now)) {
      // A recent outage: answer now — from the stale copy when there is one.
      if (cached && !failed.permanent) return cached.body;
      throw failed.permanent ? new PermanentError(failed.message) : new TransientError(failed.message);
    }
    negative.delete(url);
  }

  let shared = inFlight.get(url);
  // A download that every earlier caller abandoned is being torn down: it
  // would only hand this caller someone else's cancellation. Start afresh.
  if (shared?.controller.signal.aborted) shared = undefined;
  if (!shared) {
    if (request?.signal?.aborted) throw new RequestCancelledError();
    // The llms.txt indexes (served as MCP resources through this cache) are
    // the same shared files the memos hold: never charged, never queued behind pages.
    const sharedFile = isSharedFile(url);
    const charged = sharedFile ? undefined : request?.client;
    reserveOutboundBudget(charged);
    const controller = new AbortController();
    const entry: SharedFetch = { promise: Promise.resolve(''), controller, callers: new Set() };
    entry.promise = refresh(url, cached, entry, sharedFile ? 'high' : 'normal', charged).finally(() => {
      if (inFlight.get(url) === entry) inFlight.delete(url);
    });
    entry.promise.catch(() => {}); // every caller may have left; the outcome is handled below
    shared = entry;
    inFlight.set(url, shared);
  }
  return join(url, shared, request, cached);
}

/**
 * Wait for a shared download on behalf of one caller. A cancelled caller, or
 * one whose request is out of time (`endBy`, FETCH.requestBudgetMs over
 * HTTP), stops waiting at once; the download itself goes on for the others,
 * and is aborted only when every caller has left. With a stale copy at hand,
 * a slow refresh is not waited for beyond `FETCH.staleGraceMs`, nor beyond
 * the request's own time — it completes in the background.
 */
async function join(
  url: string,
  shared: SharedFetch,
  request: RequestContext | undefined,
  stale?: CacheEntry
): Promise<string> {
  const endBy = request?.endBy;
  const caller: Caller = { endBy: endBy ?? Number.POSITIVE_INFINITY };
  shared.callers.add(caller);
  const timers: NodeJS.Timeout[] = [];
  const candidates: Array<Promise<string>> = [shared.promise];
  const left = endBy === undefined ? undefined : Math.max(0, endBy - Date.now());
  if (stale) {
    // Never waited for past the request's own time: with less than the grace
    // left, the stale copy is the answer when the time is up, not an error.
    const grace = left === undefined ? FETCH.staleGraceMs : Math.min(FETCH.staleGraceMs, left);
    candidates.push(
      new Promise<string>((resolve) => {
        timers.push(setTimeout(() => resolve(stale.body), grace));
      })
    );
  }
  if (left !== undefined) {
    candidates.push(
      new Promise<string>((_, reject) => {
        timers.push(
          setTimeout(
            () => reject(new FetchDeadlineError(`No answer within the ${left} ms left to this request for ${url}`)),
            left
          )
        );
      })
    );
  }
  try {
    return await unlessCancelled(Promise.race(candidates), request?.signal);
  } catch (err) {
    if (err instanceof RequestCancelledError || err instanceof FetchDeadlineError) {
      shared.callers.delete(caller);
      if (shared.callers.size === 0) shared.controller.abort(err);
    }
    throw err;
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
}

/** The index and full-text files every tool depends on. */
function isSharedFile(url: string): boolean {
  return DOCS.sources.some((s) => s.indexUrl === url || s.fullTextUrl === url);
}

async function refresh(
  url: string,
  cached: CacheEntry | undefined,
  shared: SharedFetch,
  priority: FetchPriority,
  charged: string | undefined
): Promise<string> {
  let result: ConditionalResult;
  // The page was reserved when queued; a retry is not a new page. A fetch
  // that never got an outbound slot gives the reservation back.
  const reservedAt = Date.now();
  let started = false;
  const onStart = (): void => {
    started = true;
  };
  try {
    // The caller's priority and batch size. Its deadline never cuts the
    // download short — the download is shared, and each caller applies its
    // own deadline in join; a slot that comes once every caller is about out
    // of time is not used, though — but a batch's pages may run until it.
    const { client, batch, endBy } = currentRequest() ?? {};
    result = await conditionalFetch(url, cached, {
      signal: shared.controller.signal,
      client,
      priority,
      onStart,
      batch,
      endBy,
      wantedUntil: () => wantedUntil(shared),
    });
  } catch (err) {
    // Not charged: a fetch that never started (no outbound slot in time,
    // refused as busy, or its callers gone before it got one). One that
    // reached the site is charged, even when its callers left before the
    // answer: the request was made.
    if (!started && charged !== undefined) refundOutboundBudget(charged, reservedAt);
    if (err instanceof PermanentError) {
      rememberFailure(url, Date.now() + FETCH.negativeTtlMs, err.message, true);
    } else if (isSiteFailure(err, started)) {
      // Only a host that was asked and failed is remembered: a page that
      // never got an outbound slot (a busy server), or whose attempt was cut
      // short of FETCH.timeoutMs by the fetch's overall limit, says nothing
      // certain about the site, and may be asked for again at once.
      rememberFailure(url, Date.now() + failureMemoFor(err), (err as Error).message, false);
    }
    // Upstream is unreachable or busy: an hour-old page beats no page at all.
    if (cached && !(err instanceof PermanentError)) return cached.body;
    throw err;
  }
  if (result.status === 'unchanged') {
    // `cached` is guaranteed here: a 304 is only accepted when validators were sent.
    const entry = cached as CacheEntry;
    if (cache.get(url) === entry) {
      entry.fetchedAt = Date.now();
      touch(url, entry);
    } else {
      // Evicted while it was being revalidated (expired entries go first when
      // the cache is full): put back through the byte accounting.
      setCached(url, entry.body, { etag: entry.etag, lastModified: entry.lastModified });
    }
    return entry.body;
  }
  // An empty page is no page: refused and remembered like a 404, not cached
  // for an hour. (The index and full-text files say so in their own terms:
  // see SourceMemo.)
  if (result.body.trim() === '') {
    const message = `Empty answer (no page content) for ${url}`;
    rememberFailure(url, Date.now() + FETCH.negativeTtlMs, message, true);
    throw new PermanentError(message);
  }
  // A download everyone abandoned may still complete (upstream ignored the
  // abort); a newer download may have replaced it meanwhile, so it is not kept.
  if (!shared.controller.signal.aborted) setCached(url, result.body, result.validators);
  return result.body;
}

/**
 * `high` for the shared index and full-text files a call needs (a handful of
 * fixed URLs every tool depends on): they jump the queue and are never
 * refused for a full queue. `normal` for user-chosen pages. `background` for
 * the same shared files reloaded with no call waiting (the health probes'
 * retries): they go last, a few at a time, and always leave a slot free.
 */
export type FetchPriority = 'high' | 'normal' | 'background';

/**
 * A fetch's priority that can still be raised while it waits for a slot: a
 * background reload that a call comes to need (it joins the download a
 * health probe started) must not keep waiting at the probe's priority.
 */
export class FetchPriorityControl {
  /** The waiter this fetch has in the queue, while it has one. */
  waiter: Waiter | undefined;

  constructor(public priority: FetchPriority) {}

  /** From background to high: now, if waiting (it goes ahead of every page fetch), and for a retry. */
  raise(): void {
    if (this.priority !== 'background') return;
    this.priority = 'high';
    const waiter = this.waiter;
    if (!waiter) return;
    waiters.splice(waiters.indexOf(waiter), 1);
    waiter.priority = 'high';
    queueHigh(waiter);
    grantFreeSlots();
  }
}

/** How a fetch takes part in the outbound queue. */
export interface FetchOptions {
  /** Aborts the fetch, including while it waits for a slot. */
  signal?: AbortSignal;
  /** The HTTP client the fetch is for; its share of the queue is bounded. */
  client?: string;
  /** Absolute deadline for getting an outbound slot (ms since epoch); defaults to now + FETCH.timeoutMs. */
  deadline?: number;
  /** How the fetch queues for a slot (see FetchPriority); `normal` by default. */
  priority?: FetchPriority;
  /** The priority as one that can be raised while waiting; takes the place of `priority`. */
  control?: FetchPriorityControl;
  /** Called when an attempt gets its outbound slot and really starts. */
  onStart?: () => void;
  /**
   * When the last of the callers waiting for this fetch stops waiting (ms
   * since epoch; Infinity for one with no deadline), read when a slot comes:
   * a request no caller would have the time for is not sent (see
   * FETCH.minAttemptMs). Absent, the fetch's own limit alone decides.
   */
  wantedUntil?: () => number;
  /**
   * How many pages the call fetches together (read_docs_batch): they queue at
   * once, so each may wait for its slot one FETCH.timeoutMs per round of
   * pages, and all of it ends FETCH.batchTimeoutMs after queueing — or at
   * `endBy`, when that is later.
   */
  batch?: number;
  /**
   * When the call that starts the fetch stops waiting for it (ms since epoch;
   * an HTTP call's request budget, see FETCH.requestBudgetMs). Only the pages
   * of a batch of more than one round use it: they may wait for their turn
   * and run until then when it is later than their FETCH.batchTimeoutMs, as
   * under load their turns come late while the call still has time for them.
   */
  endBy?: number;
}

/**
 * Perform one conditional GET without touching the cache. When `validators`
 * are provided they are sent as If-None-Match / If-Modified-Since, and a 304
 * answer yields `{ status: 'unchanged' }`. Used directly by the full-text
 * loader, which keeps parsed sections instead of raw multi-megabyte bodies.
 * A 5xx answer or a network error is retried once when the failed attempt
 * took less than half of `FETCH.timeoutMs`: a host that answers 5xx slowly
 * costs one timeout, not two. A timeout is not retried — the host is hanging.
 * Each wait (for a slot, for an answer) is capped at `FETCH.timeoutMs`, and
 * the whole fetch, retry included, at `FETCH.overallTimeoutMs` from queueing —
 * except for the pages of a batch, which queue together: they may wait one
 * `FETCH.timeoutMs` per round of pages for a slot, and end at
 * `FETCH.batchTimeoutMs` — or at the call's own `endBy`, when that is later.
 */
export async function conditionalFetch(
  url: string,
  validators?: CacheValidators,
  options: FetchOptions = {}
): Promise<ConditionalResult> {
  const queuedAt = Date.now();
  // A client's pages run FETCH.maxActivePerClient at a time when others wait;
  // the stdio server's, FETCH.maxConcurrent.
  const perRound = options.client === undefined ? FETCH.maxConcurrent : FETCH.maxActivePerClient;
  const rounds = Math.ceil((options.batch ?? 1) / perRound);
  // A background reload may wait for its place behind another that hangs
  // (they run FETCH.maxBackgroundFetches at a time) and still start once
  // that one times out, instead of timing out with it.
  const background = (options.control?.priority ?? options.priority) === 'background';
  const slotWait = background ? FETCH.overallTimeoutMs : FETCH.timeoutMs * rounds;
  // A batch's pages wait for their turn and run until the call stops waiting
  // for them, when that is later than their own limit (see endBy).
  const callEnd = rounds > 1 ? (options.endBy ?? Number.NEGATIVE_INFINITY) : Number.NEGATIVE_INFINITY;
  const giveUpAt = Math.max(
    callEnd,
    queuedAt +
      (background
        ? FETCH.overallTimeoutMs + FETCH.timeoutMs
        : rounds > 1
          ? FETCH.batchTimeoutMs
          : FETCH.overallTimeoutMs)
  );
  let startedAt = Number.NaN;
  const attempt: FetchOptions & { deadline: number; giveUpAt: number; overallMs: number } = {
    ...options,
    overallMs: Math.round((giveUpAt - queuedAt) / 1000) * 1000,
    deadline: options.deadline ?? Math.max(callEnd, queuedAt + slotWait),
    giveUpAt,
    onStart: () => {
      startedAt = Date.now();
      options.onStart?.();
    },
  };
  try {
    return await doFetch(url, validators, attempt);
  } catch (err) {
    // Never at once after a timeout (the host hangs) or a request to slow down.
    const again = isTransientFailure(err) && !(err instanceof FetchTimeoutError) && !(err instanceof SlowDownError);
    if (!again || options.signal?.aborted) throw err;
    // Retry only when the failed attempt took a small share of its time —
    // a host that answers 5xx slowly costs one timeout, not two — and stop
    // sleeping the moment the request is cancelled.
    if (Date.now() - startedAt >= FETCH.timeoutMs / 2) throw err;
    // Nor when the whole fetch would be out of time before the retry starts.
    if (Date.now() + FETCH.retryDelayMs >= giveUpAt) throw err;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, FETCH.retryDelayMs);
      options.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new RequestCancelledError());
        },
        { once: true }
      );
    });
    // The retry may wait for a slot as long as the whole fetch has left.
    return doFetch(url, validators, { ...attempt, deadline: giveUpAt });
  }
}

/**
 * True for failures where retrying, or trying a different URL, is pointless
 * because the server or network — not the specific resource — is at fault:
 * 5xx responses, undici network errors (a TypeError whose message is
 * "fetch failed", carrying the socket error as `cause`), and timeouts.
 * Other TypeErrors (an invalid URL, a bad header value) are programming
 * errors and are not retried.
 */
export function isTransientFailure(err: unknown): boolean {
  if (err instanceof TransientError) return true;
  if (err instanceof TypeError) return err.message === 'fetch failed' || err.cause !== undefined;
  return false;
}

/** True for answers that a retry or a fallback URL cannot change (4xx, HTML). */
export function isPermanentFailure(err: unknown): boolean {
  return err instanceof PermanentError;
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Global cap on simultaneous outbound requests: a counting semaphore whose
 * queue is bounded for normal fetches and lets high-priority ones go first.
 */
let active = 0;
/** Slots held by background fetches (see FetchPriority). */
let activeBackground = 0;
/** One taken outbound slot: who holds it, and since when. */
interface Slot {
  priority: FetchPriority;
  client: string | undefined;
  at: number;
  /** Taken past the client's share, into a slot that was idle (see mayRun). */
  borrowed: boolean;
  /** When the request sent in it reaches its own limit and is aborted (ms since epoch; see upstreamIdleSince). */
  until: number;
  /** Whether the site has answered the request sent in it (its headers came: see backgroundHanging). */
  answered: boolean;
}
const slots = new Set<Slot>();
interface Waiter {
  priority: FetchPriority;
  client: string | undefined;
  grant: (slot: Slot) => void;
}
const waiters: Waiter[] = [];
/** Page fetches running per HTTP client (see FETCH.maxActivePerClient). */
const activeByClient = new Map<string, number>();

/**
 * The slots there are now: FETCH.maxConcurrent, and one more while a client
 * holds a slot it borrowed (past its share, when it was alone) — a slot lent
 * while idle is not one the others lose: the extra one is for a client
 * running nothing yet (see mayRun), which gets it the moment it asks, not
 * once the borrowed fetch has hung for 5 s. A client borrows only into an
 * idle slot that leaves another free, not while a fetch hangs, and never a
 * second one, so the extra slot is one. And one more for each background
 * reload that hangs (see backgroundHanging): it runs on beside the slots, so
 * the reload it handed its turn to takes none from the calls.
 */
function capacity(): number {
  return FETCH.maxConcurrent + (lent() ? 1 : 0) + backgroundHanging();
}

/**
 * Background reloads that have had no answer for FETCH.slowFetchMs, at most
 * FETCH.maxBackgroundFetches of them: each has handed its turn to the next
 * file to reload (see mayRun), so files that hang do not keep the others
 * waiting for their 20 s.
 */
function backgroundHanging(): number {
  const since = Date.now() - FETCH.slowFetchMs;
  let hanging = 0;
  for (const slot of slots) if (slot.priority === 'background' && !slot.answered && slot.at <= since) hanging += 1;
  return Math.min(hanging, FETCH.maxBackgroundFetches);
}

/** Whether some client holds a slot it borrowed past its share. */
function lent(): boolean {
  for (const slot of slots) if (slot.borrowed) return true;
  return false;
}

/** Whether a fetch has held its slot past FETCH.slowFetchMs: the site is hanging, at least for some pages. */
function someFetchHanging(): boolean {
  const since = Date.now() - FETCH.slowFetchMs;
  for (const slot of slots) if (slot.at < since) return true;
  return false;
}

/**
 * Whether a fetch may take a free slot now:
 * - a client runs up to its share of the slots, and beyond it only into
 *   idle slots, always leaving one free, not while some fetch hangs, and
 *   never a second one — a batch alone on the server uses the idle slots
 *   (another client waiting for a slot goes first: see grantFreeSlots);
 * - the last free slot is kept for an HTTP client running nothing yet
 *   while fewer than three clients run pages, so no two clients can hold
 *   every slot between them, from their first pages on (three can, while
 *   those run: a share, and a first slot each for two that were running
 *   nothing yet); and while some fetch hangs, or a client holds a slot it
 *   borrowed, so the clients whose pages hang cannot hold every slot past
 *   their first round, and a slot lent while idle is not one a newcomer
 *   loses;
 * - background reloads (the health probes') run a few at a time and always
 *   leave a slot free; one that hangs has handed its turn on (see
 *   backgroundHanging).
 * The shared files a call needs (high) and the stdio server (no client) take
 * any free slot.
 */
function mayRun(waiter: Pick<Waiter, 'priority' | 'client'>): boolean {
  const free = capacity() - active;
  if (free <= 0) return false;
  if (waiter.priority === 'high') return true;
  if (waiter.priority === 'background') {
    return free >= 2 && activeBackground - backgroundHanging() < FETCH.maxBackgroundFetches;
  }
  const { client } = waiter;
  if (client === undefined) return true;
  const running = activeByClient.get(client) ?? 0;
  if (running === 0) return true;
  if (free === 1 && (activeByClient.size <= 2 || siteHanging() || lent())) return false;
  if (running < FETCH.maxActivePerClient) return true;
  // Past its share: not into what would be a second borrowed slot (see take).
  const borrowed = borrowedBy(client);
  if (borrowed > 0 && running - borrowed >= FETCH.maxActivePerClient) return false;
  return free >= 2 && !siteHanging();
}

/**
 * Whether the site is hanging for the slot rules: a fetch holds its slot
 * past FETCH.slowFetchMs, or one timed out waiting for an answer within
 * FETCH.hangMemoMs — so when the hanging fetches time out together, the
 * last free slot stays kept for a client running nothing yet instead of
 * going to the same clients' next pages. Unlike /health's reason, this is
 * not ended by an answer: the clients whose pages hung have their next
 * pages queued, and a newcomer's one answered page says nothing about those
 * — it would only hand the kept slot back to them until their pages hang
 * visibly again, 5 s on.
 */
function siteHanging(): boolean {
  return someFetchHanging() || withinLast(lastAnswerTimeoutAt, FETCH.hangMemoMs);
}

/** Slots the client holds past its share (see take). */
function borrowedBy(client: string): number {
  let n = 0;
  for (const slot of slots) if (slot.borrowed && slot.client === client) n += 1;
  return n;
}

/** Take a free slot for this fetch. */
function take(priority: FetchPriority, client: string | undefined): Slot {
  // Borrowed: past the client's own share, i.e. it already holds that many
  // slots that are not borrowed (a slot taken after one of its own ended is
  // within the share again, even while a borrowed one runs on).
  const borrowed =
    priority === 'normal' &&
    client !== undefined &&
    (activeByClient.get(client) ?? 0) - borrowedBy(client) >= FETCH.maxActivePerClient;
  const slot: Slot = { priority, client, at: Date.now(), borrowed, until: Number.POSITIVE_INFINITY, answered: false };
  slots.add(slot);
  active += 1;
  if (priority === 'background') activeBackground += 1;
  if (priority === 'normal' && client !== undefined) activeByClient.set(client, (activeByClient.get(client) ?? 0) + 1);
  return slot;
}

/** When each client was last given an outbound slot (a grant counter, not a clock). */
const lastGrant = new Map<string | undefined, number>();
let grants = 0;

/** Queue a high-priority waiter ahead of every other kind, behind the high ones already waiting. */
function queueHigh(waiter: Waiter): void {
  const firstOther = waiters.findIndex((w) => w.priority !== 'high');
  if (firstOther === -1) waiters.push(waiter);
  else waiters.splice(firstOther, 0, waiter);
}

function acquire(
  signal: AbortSignal,
  priority: FetchPriority,
  client: string | undefined,
  control?: FetchPriorityControl
): Promise<Slot> {
  if (mayRun({ priority, client })) return Promise.resolve(take(priority, client));
  if (priority === 'normal') {
    let queued = 0;
    let own = 0;
    for (const w of waiters) {
      if (w.priority !== 'normal') continue;
      queued += 1;
      if (client !== undefined && w.client === client) own += 1;
    }
    // One client (one batch of 20 pages, say) may hold a share of the queue,
    // never all of it.
    if (queued >= FETCH.maxQueued || own >= FETCH.maxQueuedPerClient) {
      return Promise.reject(
        new FetchBusyError(
          `The documentation host is busy (${own >= FETCH.maxQueuedPerClient ? FETCH.maxQueuedPerClient : FETCH.maxQueued} ` +
            `page fetches already waiting${own >= FETCH.maxQueuedPerClient ? ' for this client' : ''}); retry in a few seconds.`
        )
      );
    }
  }
  return new Promise<Slot>((resolve, reject) => {
    const onAbort = (): void => {
      if (control) control.waiter = undefined;
      waiters.splice(waiters.indexOf(waiter), 1);
      lastSettledAt = Date.now();
      if (!waiters.some((w) => w.client === client)) lastGrant.delete(client);
      reject(signal.reason);
      // A waiter that leaves may have kept a borrowing client from an idle
      // slot — handed on once the rest of the cancellation has run: a call
      // leaving takes its queued pages with it one by one, and a slot its
      // first page frees must not go to its second, aborted a moment later.
      queueMicrotask(grantFreeSlots);
    };
    const waiter: Waiter = {
      priority,
      client,
      grant: (slot) => {
        if (control) control.waiter = undefined;
        signal.removeEventListener('abort', onAbort);
        resolve(slot);
      },
    };
    if (priority === 'high') queueHigh(waiter);
    else waiters.push(waiter);
    if (control) control.waiter = waiter;
    // A client that starts waiting counts as served just now: it goes after
    // the clients already waiting that were served longer ago, not first.
    if (!lastGrant.has(client)) lastGrant.set(client, grants);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Hand free slots to the next waiters: high-priority fetches (the shared
 * index and full-text files) first, then page fetches round-robin across
 * clients — the waiting client served longest ago goes next, oldest request
 * first — so one client's queued batch cannot delay everyone else's page;
 * a client past its share after them, and background reloads last. A waiter
 * that may not run yet (see mayRun) is passed over.
 */
function grantFreeSlots(): void {
  const borrowing = (w: Waiter): boolean =>
    w.client !== undefined && (activeByClient.get(w.client) ?? 0) >= FETCH.maxActivePerClient;
  // Tiers, in order: the shared files and the clients within their share
  // (round-robin), then a client past its share, then background reloads.
  const tier = (w: Waiter): number =>
    w.priority === 'background' ? 2 : w.priority === 'normal' && borrowing(w) ? 1 : 0;
  const rank = (w: Waiter): number =>
    w.priority === 'high' ? Number.NEGATIVE_INFINITY : (lastGrant.get(w.client) as number);
  while (active < capacity()) {
    let next = -1;
    let bestTier = Number.POSITIVE_INFINITY;
    let bestRank = Number.POSITIVE_INFINITY;
    waiters.forEach((w, i) => {
      if (!mayRun(w)) return;
      const t = tier(w);
      const r = rank(w);
      if (t < bestTier || (t === bestTier && r < bestRank)) {
        next = i;
        bestTier = t;
        bestRank = r;
      }
    });
    if (next === -1) return;
    const [waiter] = waiters.splice(next, 1) as [Waiter];
    grants += 1;
    // Only waiting clients need remembering, so the map stays as small as the queue.
    if (waiters.some((w) => w.client === waiter.client)) lastGrant.set(waiter.client, grants);
    else lastGrant.delete(waiter.client);
    waiter.grant(take(waiter.priority, waiter.client));
  }
}

/** Give a slot back, and hand the free slots on. */
function release(slot: Slot): void {
  slots.delete(slot);
  active -= 1;
  lastSettledAt = Date.now();
  if (slot.priority === 'background') activeBackground -= 1;
  if (slot.priority === 'normal' && slot.client !== undefined) {
    const running = (activeByClient.get(slot.client) as number) - 1;
    if (running === 0) activeByClient.delete(slot.client);
    else activeByClient.set(slot.client, running);
  }
  grantFreeSlots();
}

/** When the site last left a fetch unanswered until it timed out (ms since epoch); remembered for FETCH.hangMemoMs. */
let lastAnswerTimeoutAt = Number.NEGATIVE_INFINITY;
/** Whether the site has answered a fetch since then: that ends /health's reason, not the slot rule's (see siteHanging). */
let answeredSince = true;

/** When the site last sent something, an answer's headers or a chunk of body (ms since epoch; see upstreamIdleSince). */
let lastReceivedAt = Number.NEGATIVE_INFINITY;
/** When a fetch last stopped being in flight: its slot given back, or its wait for one over (see upstreamIdleSince). */
let lastSettledAt = Number.NEGATIVE_INFINITY;
/** Set by stopSendingOnHang: the site leaving a request unanswered from then on stops the sending. */
let stopOnHang = false;
/** When the site, after stopSendingOnHang, first left a request unanswered for its full FETCH.timeoutMs: nothing is sent since. */
let sendingStoppedAt: number | undefined;

/**
 * For the stdio entry's end, once its client has closed stdin: from now on,
 * the first request the site leaves unanswered for its full FETCH.timeoutMs
 * (it is hanging) stops the sending. No request that is not yet sent goes
 * out — each fails at once, like one that never got a slot — so the calls
 * still running answer with what they have instead of sending another round
 * to a hanging site; the requests already sent run on to their own limits.
 */
export function stopSendingOnHang(): void {
  stopOnHang = true;
}

/**
 * Since when the running calls have had nothing to wait for from the site
 * (ms since epoch), for the stdio entry's end (see utils/calls-in-flight.ts):
 * the present while a fetch is in flight within its own limits — a request
 * sent and not yet at its FETCH.timeoutMs, however long its first byte
 * takes, or, while the sending goes on, one waiting for a slot; otherwise the
 * latest of the last time the site sent something (an answer's headers or a
 * chunk of body), the last time a fetch stopped being in flight, and the
 * limit of a request still holding its slot past it.
 */
export function upstreamIdleSince(now: number = Date.now()): number {
  if (sendingStoppedAt === undefined && waiters.length > 0) return now;
  let since = Math.max(lastReceivedAt, lastSettledAt);
  for (const slot of slots) {
    if (slot.until > now) return now;
    since = Math.max(since, slot.until);
  }
  return since;
}

/**
 * Whether the site looks hung, at least for some pages, for /health: a fetch
 * has held its slot over FETCH.slowFetchMs, or one waited the full
 * FETCH.timeoutMs for an answer within the last FETCH.hangMemoMs and none has
 * been answered since — so a page-only outage shows between the calls it
 * fails, not just while one waits, and no longer once the site answers,
 * with whatever status: a 304 revalidation or a 404 shows it answers as a
 * page does.
 */
export function fetchesHanging(): boolean {
  return someFetchHanging() || (!answeredSince && withinLast(lastAnswerTimeoutAt, FETCH.hangMemoMs));
}

/** Outbound queue state, for /health. */
export function fetchQueueStats(): { active: number; queued: number; maxQueued: number } {
  return { active, queued: waiters.length, maxQueued: FETCH.maxQueued };
}

async function doFetch(
  url: string,
  validators: CacheValidators | undefined,
  options: FetchOptions & { deadline: number; giveUpAt: number; overallMs: number }
): Promise<ConditionalResult> {
  // Waiting for an outbound slot (until `deadline`, FETCH.timeoutMs from
  // when the fetch was queued) and the network attempt (FETCH.timeoutMs from
  // when it starts) are timed separately: a page queued behind other
  // readers is not timed out before it has started. Both end, at the latest,
  // at `giveUpAt`: FETCH.overallTimeoutMs from when the fetch was queued.
  const controller = new AbortController();
  const slotWaitUntil = Math.min(options.deadline, options.giveUpAt);
  const slotWait = Math.round((slotWaitUntil - Date.now()) / 1000) * 1000;
  let timer = setTimeout(
    () => controller.abort(new FetchTimeoutError(`No outbound slot within ${slotWait} ms for ${url}`)),
    Math.max(0, slotWaitUntil - Date.now())
  );
  const cancel = (): void => controller.abort(new RequestCancelledError());
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener('abort', cancel, { once: true });
  let slot: Slot;
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    slot = await acquire(
      controller.signal,
      options.control?.priority ?? options.priority ?? 'normal',
      options.client,
      options.control
    );
  } catch (err) {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    throw err;
  }
  clearTimeout(timer);
  const now = Date.now();
  const left = options.giveUpAt - now;
  // What the callers still have: a call out of time leaves (see join), and a
  // batch's queued pages must not be sent into the slots its running ones
  // free at the deadline, to be aborted the next moment.
  const wanted = (options.wantedUntil?.() ?? Number.POSITIVE_INFINITY) - now;
  const notSent =
    sendingStoppedAt !== undefined
      ? `Not sent: the site left a request unanswered for ${FETCH.timeoutMs} ms after the client closed stdin, for ${url}`
      : left < FETCH.minAttemptMs
        ? `No outbound slot within ${options.overallMs} ms of queueing for ${url}`
        : wanted < FETCH.minAttemptMs
          ? `No outbound slot within the time left to the calls waiting for ${url}`
          : undefined;
  if (notSent !== undefined) {
    // A slot that came too late for a request to be worth sending, or after
    // the sending stopped: it goes to the next fetch, and this one never
    // started (nothing charged, nothing remembered of the site).
    release(slot);
    options.signal?.removeEventListener('abort', cancel);
    throw new FetchTimeoutError(notSent, true);
  }
  const attemptMs = Math.max(0, Math.min(FETCH.timeoutMs, left));
  slot.until = now + attemptMs;
  timer = setTimeout(() => {
    // The site's own silence counts, not an attempt this fetch's overall
    // limit cut short of the full wait.
    const cutShort = left < FETCH.timeoutMs;
    if (!cutShort) {
      lastAnswerTimeoutAt = Date.now();
      answeredSince = false;
      // Before the abort: the slot this fetch frees must not send the next request.
      if (stopOnHang) sendingStoppedAt ??= lastAnswerTimeoutAt;
    }
    controller.abort(
      cutShort
        ? new FetchTimeoutError(`No answer within ${options.overallMs} ms of queueing for ${url}`, true)
        : new FetchTimeoutError(`No answer within ${FETCH.timeoutMs} ms for ${url}`)
    );
  }, attemptMs);
  // A background reload with no answer by FETCH.slowFetchMs hands its turn on (see backgroundHanging).
  const handOn = slot.priority === 'background' ? setTimeout(grantFreeSlots, FETCH.slowFetchMs) : undefined;
  options.onStart?.();
  try {
    const headers: Record<string, string> = {
      'User-Agent': FETCH.userAgent,
      Accept: 'text/plain, text/markdown;q=0.9, */*;q=0.5',
    };
    const conditional = Boolean(validators?.etag || validators?.lastModified);
    if (validators?.etag) headers['If-None-Match'] = validators.etag;
    if (validators?.lastModified) headers['If-Modified-Since'] = validators.lastModified;

    // Redirects are followed manually so every hop is re-validated against the
    // outbound allowlist: `redirect: 'follow'` would let the docs host bounce
    // us to an arbitrary (e.g. internal) address after the first check passed.
    let current = url;
    for (let hop = 0; ; hop++) {
      const res = await fetch(current, { signal: controller.signal, redirect: 'manual', headers });
      // The site answers again, whatever it says (a 304, a 404 or a 5xx as
      // much as a page): /health's "hanging" reason ends; the slot rule's
      // memo runs on (see siteHanging).
      answeredSince = true;
      lastReceivedAt = Date.now();
      slot.answered = true;

      if (res.status === 304) {
        await discard(res);
        if (!conditional) throw new TransientError(`Unexpected 304 Not Modified (no validators sent) for ${current}`);
        return { status: 'unchanged' };
      }

      if (REDIRECT_CODES.has(res.status)) {
        await discard(res);
        const location = res.headers.get('location');
        if (!location) throw new PermanentError(`Redirect (${res.status}) without a Location header for ${current}`);
        if (hop >= FETCH.maxRedirects)
          throw new PermanentError(`Too many redirects (>${FETCH.maxRedirects}) starting at ${url}`);
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          throw new PermanentError(`Redirect (${res.status}) to an invalid Location for ${current}`);
        }
        if (!isAllowedDocUrl(next)) {
          throw new PermanentError(`Refusing to follow redirect off the documentation host: ${next} (for ${url})`);
        }
        current = next;
        continue;
      }

      if (!res.ok) {
        await discard(res);
        const message = `HTTP ${res.status} ${res.statusText} for ${current}`;
        if (res.status === 408 || res.status === 429) {
          throw new SlowDownError(message, retryAfterMs(res.headers.get('retry-after')));
        }
        throw res.status >= 500 ? new TransientError(message) : new PermanentError(message);
      }
      // The docs site serves markdown as text/plain or text/markdown. HTML means
      // the path is not a documentation page (the site's shell, a 404 page).
      const contentType = res.headers.get('content-type') ?? '';
      if (/^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
        await discard(res);
        throw new PermanentError(`Not a documentation page (HTML response) for ${current}`);
      }
      const contentLength = Number(res.headers.get('content-length') ?? 0);
      if (contentLength > FETCH.maxResponseBytes) {
        await discard(res);
        throw new PermanentError(`Response too large (${contentLength} bytes) for ${current}`);
      }
      const body = await readCapped(res, current);
      return {
        status: 'fresh',
        body,
        validators: {
          etag: res.headers.get('etag') ?? undefined,
          lastModified: res.headers.get('last-modified') ?? undefined,
        },
      };
    }
  } catch (err) {
    // An abort surfaces as whatever undici makes of it; report why we aborted.
    throw controller.signal.aborted ? controller.signal.reason : err;
  } finally {
    clearTimeout(timer);
    clearTimeout(handOn);
    options.signal?.removeEventListener('abort', cancel);
    release(slot);
  }
}

/**
 * The body as text, read in chunks and counted as it arrives, so a response
 * over `FETCH.maxResponseBytes` (chunked, or compressed and decoded on the
 * way, so without a usable Content-Length) is cut off at the cap instead of
 * being buffered whole and refused afterwards.
 */
async function readCapped(res: Response, current: string): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    lastReceivedAt = Date.now();
    bytes += value.byteLength;
    if (bytes > FETCH.maxResponseBytes) {
      await reader.cancel().catch(ignore);
      throw new PermanentError(`Response too large (over ${FETCH.maxResponseBytes} bytes) for ${current}`);
    }
    chunks.push(value);
  }
  // A leading byte-order mark is not text (Response.text() drops it too).
  const text = Buffer.concat(chunks).toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Drop a body nobody reads (redirects, errors): unread, it would hold its socket until garbage collection. */
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(ignore);
}

/** A cancel that fails (a body already consumed or locked) changes nothing. */
function ignore(): void {}

/**
 * Return the cached body for a URL when present and fresh, without fetching.
 * No server code reads the cache this way; the tests use it to see what the
 * cache holds.
 */
export function peekCached(url: string): string | undefined {
  const entry = cache.get(url);
  if (entry && withinLast(entry.fetchedAt, CACHE.ttlMs)) return entry.body;
  return undefined;
}

/** Move an entry to the most-recently-used end of the map. */
function touch(url: string, entry: CacheEntry): void {
  cache.delete(url);
  cache.set(url, entry);
}

/**
 * Insert into the cache. Eviction is both entry-count and byte aware:
 * expired entries go first, then the least recently used, until under both
 * caps. Sizes are counted in UTF-8 bytes, not UTF-16 code units.
 */
function setCached(url: string, body: string, validators: CacheValidators = {}): void {
  const now = Date.now();
  const bytes = Buffer.byteLength(body);
  const existing = cache.get(url);
  if (existing) {
    cacheBytes -= existing.bytes;
    cache.delete(url);
  }
  // One huge body must not push every page out: it is served, not kept.
  if (bytes > CACHE.maxEntryBytes) return;
  if (cache.size >= CACHE.maxEntries || cacheBytes + bytes > CACHE.maxBytes) {
    for (const [key, entry] of cache) {
      if (!withinLast(entry.fetchedAt, CACHE.ttlMs, now)) {
        cacheBytes -= entry.bytes;
        cache.delete(key);
      }
    }
    // Maps iterate in insertion order and `touch` re-inserts on every hit, so
    // the first key is the least recently used.
    while (cache.size >= CACHE.maxEntries || (cache.size > 0 && cacheBytes + bytes > CACHE.maxBytes)) {
      const oldest = cache.keys().next().value as string;
      cacheBytes -= (cache.get(oldest) as CacheEntry).bytes;
      cache.delete(oldest);
    }
  }
  cache.set(url, { body, bytes, fetchedAt: now, ...validators });
  cacheBytes += bytes;
}

/** Cache statistics for observability (/health, diagnostics). */
export function cacheStats(): { entries: number; bytes: number; failures: number } {
  return { entries: cache.size, bytes: cacheBytes, failures: negative.size };
}

/** Exposed for tests. */
export function clearHttpCache(): void {
  cache.clear();
  negative.clear();
  inFlight.clear();
  budgets.clear();
  cacheBytes = 0;
  lastAnswerTimeoutAt = Number.NEGATIVE_INFINITY;
  answeredSince = true;
  lastReceivedAt = Number.NEGATIVE_INFINITY;
  lastSettledAt = Number.NEGATIVE_INFINITY;
  stopOnHang = false;
  sendingStoppedAt = undefined;
}

/** Exposed for tests: pre-seed the cache so no network is needed. */
export function seedHttpCache(url: string, body: string): void {
  setCached(url, body);
}
