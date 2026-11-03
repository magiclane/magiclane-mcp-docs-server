/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cacheStats,
  clearHttpCache,
  conditionalFetch,
  FetchBudgetError,
  FetchBusyError,
  fetchQueueStats,
  fetchText,
  FetchDeadlineError,
  isLoadFailure,
  isPermanentFailure,
  isSiteFailure,
  isTransientFailure,
  peekCached,
  fetchBudgetClients,
  limitFetchBudgetClients,
  fetchesHanging,
  failureMemoFor,
  retryAfterMs,
  seedHttpCache,
  stopSendingOnHang,
  sweepFetchBudgets,
  upstreamIdleSince,
} from '../../src/utils/http-client.js';
import { CACHE, FETCH } from '../../src/config/constants.js';
import { RequestCancelledError, withRequestContext } from '../../src/utils/request-context.js';

/** A fetch that never answers on its own: it rejects only when its signal aborts. */
function hanging(_url: string, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });
}

function okResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, statusText: 'OK', headers });
}

function errorResponse(status: number, statusText: string): Response {
  return new Response('', { status, statusText });
}

function redirectResponse(status: number, location?: string): Response {
  return new Response(null, { status, statusText: 'Redirect', headers: location ? { location } : {} });
}

/** A chunked body of `chunks` pieces of `size` bytes, as a streaming Response without a Content-Length. */
function chunkedResponse(chunks: number, size: number, onCancel: () => void = () => {}): Response {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === chunks) controller.close();
      else {
        sent += 1;
        controller.enqueue(new Uint8Array(size).fill(120));
      }
    },
    cancel: onCancel,
  });
  return new Response(stream, { status: 200, statusText: 'OK' });
}

describe('fetchText', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearHttpCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('fetches and returns the response body', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('hello docs'));
    await expect(fetchText('https://developer.magiclane.com/a.md')).resolves.toBe('hello docs');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tells since when the calls have had nothing to wait for from the site', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    expect(upstreamIdleSince()).toBe(Number.NEGATIVE_INFINITY); // nothing ever came, nothing in flight
    // A request within its own limit is something to wait for, however long its first byte takes.
    let answer!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
    const slow = fetchText('https://developer.magiclane.com/idle-slow.md');
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs - 1_000);
    expect(upstreamIdleSince()).toBe(Date.now());
    answer(chunkedResponse(3, 4)); // the answer and its chunks
    await expect(slow).resolves.toHaveLength(12);
    const answeredAt = Date.now();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(upstreamIdleSince()).toBe(answeredAt); // nothing since the last chunk
    // A fetch that ends without a byte counts from when it stopped being in flight.
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')).mockRejectedValueOnce(new TypeError('fetch failed'));
    const failing = expect(fetchText('https://developer.magiclane.com/idle-failed.md')).rejects.toThrow('fetch failed');
    await vi.advanceTimersByTimeAsync(FETCH.retryDelayMs + 1); // the one retry
    await failing;
    expect(upstreamIdleSince()).toBe(start + FETCH.timeoutMs - 1_000 + 5_000 + FETCH.retryDelayMs);
    // A request still holding its slot past its own limit (its fetch ignores the abort) counts until that limit only.
    let late!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (late = resolve)));
    const stuckAt = Date.now();
    const stuck = fetchText('https://developer.magiclane.com/idle-stuck.md');
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs + 5_000);
    expect(fetchQueueStats().active).toBe(1);
    expect(upstreamIdleSince()).toBe(stuckAt + FETCH.timeoutMs);
    late(okResponse('late'));
    await stuck.catch(() => {});
  });

  it('counts a fetch waiting for a slot as something to wait for', async () => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    fetchMock.mockImplementation(
      (url: string) =>
        url.includes('queued')
          ? Promise.resolve(okResponse('in turn'))
          : new Promise<Response>((resolve) => releases.push(() => resolve(okResponse('held')))) // ignores the abort
    );
    const busy = Array.from({ length: FETCH.maxConcurrent }, (_, i) =>
      fetchText(`https://developer.magiclane.com/idle-hold-${i}.md`)
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const queued = fetchText('https://developer.magiclane.com/idle-queued.md');
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs - 10_000 + 1_000); // every request past its own limit…
    expect(fetchQueueStats().queued).toBe(1);
    expect(upstreamIdleSince()).toBe(Date.now()); // …but a page waits for its turn, within its own time
    for (const release of releases) release();
    await Promise.all(busy);
    await expect(queued).resolves.toBe('in turn');
  });

  it('stops sending, once asked, at the first request the site leaves unanswered for its full limit', async () => {
    vi.useFakeTimers();
    stopSendingOnHang();
    const answers: Array<() => void> = [];
    fetchMock.mockImplementation((url: string, init: RequestInit) =>
      url.includes('answered')
        ? new Promise<Response>((resolve) => answers.push(() => resolve(okResponse('answered late'))))
        : hanging(url, init)
    );
    // Every slot but one hangs; a page waits for its turn behind them.
    const hung = Array.from({ length: FETCH.maxConcurrent - 1 }, (_, i) =>
      fetchText(`https://developer.magiclane.com/stop-hang-${i}.md`).catch((e: unknown) => e)
    );
    await vi.advanceTimersByTimeAsync(10_000);
    // Sent 10 s later into the last slot: its answer comes after the others hang.
    const answered = fetchText('https://developer.magiclane.com/stop-answered.md');
    const queued = fetchText('https://developer.magiclane.com/stop-queued.md').catch((e: unknown) => e);
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent, queued: 1 });
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs - 10_000);
    for (const err of await Promise.all(hung)) expect(String(err)).toContain(`No answer within ${FETCH.timeoutMs} ms`);
    // The page that waited for a slot is not sent into the one the hang freed…
    const notSent = (await queued) as Error;
    expect(notSent.message).toBe(
      `Not sent: the site left a request unanswered for ${FETCH.timeoutMs} ms after the client closed stdin, for https://developer.magiclane.com/stop-queued.md`
    );
    expect(isSiteFailure(notSent, false)).toBe(false); // nothing remembered of the site
    // …nor is any page asked for afterwards.
    await expect(fetchText('https://developer.magiclane.com/stop-after.md')).rejects.toThrow('Not sent');
    expect(fetchMock).toHaveBeenCalledTimes(FETCH.maxConcurrent);
    // The request already sent runs on to its own limit, and is waited for until then.
    expect(upstreamIdleSince()).toBe(Date.now());
    await vi.advanceTimersByTimeAsync(5_000);
    (answers.shift() as () => void)();
    await expect(answered).resolves.toBe('answered late');
    expect(upstreamIdleSince()).toBe(Date.now());
  });

  it('sends a User-Agent header', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('x'));
    await fetchText('https://developer.magiclane.com/ua.md');
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ 'User-Agent': expect.stringContaining('magiclane') });
  });

  it('serves repeat requests from the cache', async () => {
    fetchMock.mockImplementation(async () => okResponse('cached'));
    await fetchText('https://developer.magiclane.com/b.md');
    await fetchText('https://developer.magiclane.com/b.md');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after the TTL expires', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => okResponse('fresh'));
    await fetchText('https://developer.magiclane.com/c.md');
    vi.advanceTimersByTime(CACHE.ttlMs + 1);
    await fetchText('https://developer.magiclane.com/c.md');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('de-duplicates concurrent requests for the same URL', async () => {
    let release!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));
    const p1 = fetchText('https://developer.magiclane.com/d.md');
    const p2 = fetchText('https://developer.magiclane.com/d.md');
    release(okResponse('once'));
    await expect(Promise.all([p1, p2])).resolves.toEqual(['once', 'once']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on non-2xx responses with the status in the message', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(404, 'Not Found'));
    await expect(fetchText('https://developer.magiclane.com/missing.md')).rejects.toThrow('HTTP 404');
  });

  it('retries a transient 5xx once and succeeds', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(500, 'Server Error')).mockResolvedValueOnce(okResponse('recovered'));
    await expect(fetchText('https://developer.magiclane.com/flaky.md')).resolves.toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails after two consecutive 5xx answers, remembers the outage briefly, then asks again', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(errorResponse(500, 'Server Error'))
      .mockResolvedValueOnce(errorResponse(502, 'Bad Gateway'))
      .mockResolvedValueOnce(okResponse('recovered'));
    const first = fetchText('https://developer.magiclane.com/flaky2.md');
    const assertion = expect(first).rejects.toThrow('HTTP 502');
    await vi.advanceTimersByTimeAsync(FETCH.retryDelayMs + 1);
    await assertion;
    // During the outage memo the answer is immediate, with no new request.
    await expect(fetchText('https://developer.magiclane.com/flaky2.md')).rejects.toThrow('HTTP 502');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(FETCH.failureMemoMs + 1);
    await expect(fetchText('https://developer.magiclane.com/flaky2.md')).resolves.toBe('recovered');
  });

  it('does not retry non-transient errors like 404', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(404, 'Not Found'));
    await expect(fetchText('https://developer.magiclane.com/gone.md')).rejects.toThrow('HTTP 404');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries network-level failures once', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(okResponse('back'));
    await expect(fetchText('https://developer.magiclane.com/net.md')).resolves.toBe('back');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps its byte count right when an entry is evicted while it is revalidated', async () => {
    vi.useFakeTimers();
    const page = 'x'.repeat(500_000);
    fetchMock.mockResolvedValueOnce(okResponse(page, { etag: '"v1"' }));
    await fetchText('https://developer.magiclane.com/evicted.md');
    vi.advanceTimersByTime(CACHE.ttlMs + 1);
    let answer!: (res: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
    const revalidating = fetchText('https://developer.magiclane.com/evicted.md');
    await vi.waitFor(() => expect(answer).toBeDefined());
    // Fill the cache: the expired entry is purged while its 304 is on the way.
    fetchMock.mockImplementation(async () => okResponse(page));
    for (let i = 0; i < 10; i++) await fetchText(`https://developer.magiclane.com/filler-${i}.md`);
    answer(new Response(null, { status: 304, statusText: 'Not Modified' }));
    await expect(revalidating).resolves.toBe(page);
    const { entries, bytes } = cacheStats();
    expect(bytes).toBe(entries * 500_000);
    expect(bytes).toBeLessThanOrEqual(CACHE.maxBytes);
  });

  it('revalidates expired entries with If-None-Match and reuses the body on 304', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(okResponse('versioned body', { etag: '"v1"' }));
    await fetchText('https://developer.magiclane.com/reval.md');
    vi.advanceTimersByTime(CACHE.ttlMs + 1);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 304,
      statusText: 'Not Modified',
      headers: new Headers(),
      text: async () => '',
    } as unknown as Response);
    await expect(fetchText('https://developer.magiclane.com/reval.md')).resolves.toBe('versioned body');
    const [, init] = fetchMock.mock.calls[1];
    expect((init as RequestInit).headers).toMatchObject({ 'If-None-Match': '"v1"' });
    // The revalidated entry is fresh again: no further fetch needed.
    fetchMock.mockClear();
    await expect(fetchText('https://developer.magiclane.com/reval.md')).resolves.toBe('versioned body');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revalidates with If-Modified-Since when only Last-Modified is available', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(okResponse('dated body', { 'last-modified': 'Tue, 01 Jul 2026 00:00:00 GMT' }));
    await fetchText('https://developer.magiclane.com/dated.md');
    vi.advanceTimersByTime(CACHE.ttlMs + 1);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 304,
      statusText: 'Not Modified',
      headers: new Headers(),
      text: async () => '',
    } as unknown as Response);
    await expect(fetchText('https://developer.magiclane.com/dated.md')).resolves.toBe('dated body');
    const [, init] = fetchMock.mock.calls[1];
    expect((init as RequestInit).headers).toMatchObject({ 'If-Modified-Since': 'Tue, 01 Jul 2026 00:00:00 GMT' });
    expect((init as RequestInit).headers).not.toHaveProperty('If-None-Match');
  });

  it('replaces the body when revalidation returns fresh content', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(okResponse('old', { etag: '"v1"' }));
    await fetchText('https://developer.magiclane.com/reval2.md');
    vi.advanceTimersByTime(CACHE.ttlMs + 1);
    fetchMock.mockResolvedValueOnce(okResponse('new', { etag: '"v2"' }));
    await expect(fetchText('https://developer.magiclane.com/reval2.md')).resolves.toBe('new');
  });

  it('evicts by total bytes, not only entry count', async () => {
    const big = 'x'.repeat(CACHE.maxEntryBytes); // 512 KB each; CACHE.maxBytes is 5 MB
    for (let i = 1; i <= 11; i++) seedHttpCache(`https://developer.magiclane.com/big-${i}.md`, big);
    expect(cacheStats().bytes).toBeLessThanOrEqual(CACHE.maxBytes);
    expect(peekCached('https://developer.magiclane.com/big-1.md')).toBeUndefined(); // oldest evicted
    expect(peekCached('https://developer.magiclane.com/big-11.md')).toBe(big);
  });

  it('serves but does not keep a body larger than the per-entry cap', async () => {
    seedHttpCache('https://developer.magiclane.com/small.md', 'kept');
    fetchMock.mockResolvedValueOnce(okResponse('y'.repeat(CACHE.maxEntryBytes + 1)));
    await expect(fetchText('https://developer.magiclane.com/huge.md')).resolves.toHaveLength(CACHE.maxEntryBytes + 1);
    expect(peekCached('https://developer.magiclane.com/huge.md')).toBeUndefined();
    expect(peekCached('https://developer.magiclane.com/small.md')).toBe('kept');
  });

  it('reports cache statistics', async () => {
    seedHttpCache('https://developer.magiclane.com/stats.md', 'abcde');
    const stats = cacheStats();
    expect(stats.entries).toBe(1);
    expect(stats.bytes).toBe(5);
  });

  it('peekCached returns fresh bodies without fetching, and nothing when expired', async () => {
    vi.useFakeTimers();
    seedHttpCache('https://developer.magiclane.com/peek.md', 'peeked');
    expect(peekCached('https://developer.magiclane.com/peek.md')).toBe('peeked');
    expect(peekCached('https://developer.magiclane.com/absent.md')).toBeUndefined();
    vi.advanceTimersByTime(CACHE.ttlMs + 1);
    expect(peekCached('https://developer.magiclane.com/peek.md')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects oversized responses announced via content-length', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('tiny', { 'content-length': String(FETCH.maxResponseBytes + 1) }));
    await expect(fetchText('https://developer.magiclane.com/huge.md')).rejects.toThrow('too large');
  });

  it('rejects oversized response bodies without content-length', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('x'.repeat(FETCH.maxResponseBytes + 1)));
    await expect(fetchText('https://developer.magiclane.com/huge2.md')).rejects.toThrow('too large');
    // Without a Content-Length, the body is cut off as soon as it passes the cap, not buffered whole.
    let cancelled = false;
    const chunk = 1024 * 1024;
    fetchMock.mockResolvedValueOnce(chunkedResponse(100, chunk, () => void (cancelled = true)));
    await expect(fetchText('https://developer.magiclane.com/huge3.md')).rejects.toThrow(
      `Response too large (over ${FETCH.maxResponseBytes} bytes)`
    );
    expect(cancelled).toBe(true);
    // A chunked body within the cap is read whole.
    fetchMock.mockResolvedValueOnce(chunkedResponse(3, 4));
    await expect(fetchText('https://developer.magiclane.com/chunked.md')).resolves.toBe('xxxxxxxxxxxx');
    // Nothing to read: an empty body is no page, refused and remembered like a 404.
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(fetchText('https://developer.magiclane.com/empty.md')).rejects.toThrow('Empty answer');
    await expect(fetchText('https://developer.magiclane.com/empty.md')).rejects.toThrow('Empty answer');
    // An oversized page is remembered too: its 10 MB are not downloaded again on each call.
    const calls = fetchMock.mock.calls.length;
    await expect(fetchText('https://developer.magiclane.com/huge3.md')).rejects.toThrow('too large');
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('evicts the oldest entry once the cache is full', async () => {
    fetchMock.mockImplementation(async (url: string) => okResponse(`body:${url}`));
    for (let i = 0; i < CACHE.maxEntries; i++) {
      await fetchText(`https://developer.magiclane.com/page-${i}.md`);
    }
    // One more insert evicts page-0 …
    await fetchText('https://developer.magiclane.com/overflow.md');
    fetchMock.mockClear();
    await fetchText('https://developer.magiclane.com/page-0.md');
    expect(fetchMock).toHaveBeenCalledTimes(1); // page-0 was re-fetched
    fetchMock.mockClear();
    await fetchText('https://developer.magiclane.com/overflow.md');
    expect(fetchMock).not.toHaveBeenCalled(); // newest entry still cached
  });

  it('sweeps expired entries when the cache is full', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < CACHE.maxEntries; i++) {
      seedHttpCache(`https://developer.magiclane.com/old-${i}.md`, 'stale');
    }
    vi.advanceTimersByTime(CACHE.ttlMs + 1);
    fetchMock.mockImplementation(async () => okResponse('new'));
    await fetchText('https://developer.magiclane.com/new.md'); // triggers the sweep
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => okResponse('refetched'));
    await expect(fetchText('https://developer.magiclane.com/old-0.md')).resolves.toBe('refetched');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts a request that exceeds the timeout, and does not wait a second time', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hanging);
    const pending = fetchText('https://developer.magiclane.com/slow.md');
    const assertion = expect(pending).rejects.toThrow(`No answer within ${FETCH.timeoutMs} ms`);
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs + 1);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isTransientFailure(await pending.catch((e: unknown) => e))).toBe(true);
    // /health says the site hangs for a while after, not only while a fetch waits…
    expect(fetchesHanging()).toBe(true);
    // …and no longer once the site answers again.
    fetchMock.mockResolvedValueOnce(okResponse('back'));
    await fetchText('https://developer.magiclane.com/answered.md');
    expect(fetchesHanging()).toBe(false);
    fetchMock.mockImplementation(hanging);
    const again = fetchText('https://developer.magiclane.com/slow2.md').catch(() => {});
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs + 1);
    await again;
    expect(fetchesHanging()).toBe(true);
    await vi.advanceTimersByTimeAsync(FETCH.hangMemoMs);
    expect(fetchesHanging()).toBe(false);
  });

  it('ends the /health hanging reason on any answer: a 304 revalidation or a 404, not only a page body', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(okResponse('versioned', { etag: '"v1"' }));
    await fetchText('https://developer.magiclane.com/warm.md');
    vi.advanceTimersByTime(CACHE.ttlMs + 1); // the cached copy expires: its next read revalidates
    const hung = async (): Promise<void> => {
      fetchMock.mockImplementationOnce(hanging);
      const pending = fetchText(`https://developer.magiclane.com/hang-${Date.now()}.md`).catch(() => {});
      await vi.advanceTimersByTimeAsync(FETCH.timeoutMs + 1);
      await pending;
      expect(fetchesHanging()).toBe(true);
    };
    // A warm server whose next fetch is a revalidation: the 304 says the site answers.
    await hung();
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 304, statusText: 'Not Modified', headers: { etag: '"v1"' } })
    );
    await expect(fetchText('https://developer.magiclane.com/warm.md')).resolves.toBe('versioned');
    expect(fetchesHanging()).toBe(false);
    // So does a 404: an answer, however unwelcome.
    await hung();
    fetchMock.mockResolvedValueOnce(errorResponse(404, 'Not Found'));
    await expect(fetchText('https://developer.magiclane.com/missing-now.md')).rejects.toThrow('HTTP 404');
    expect(fetchesHanging()).toBe(false);
  });

  it("does not take a timeout the fetch's own overall limit cut short for the site hanging", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(okResponse('fresh'));
    await fetchText('https://developer.magiclane.com/fresh.md'); // an answer: nothing remembered from before
    expect(fetchesHanging()).toBe(false);
    // Queued behind others until little of the overall limit is left: the attempt is cut short.
    const holders = Array.from({ length: FETCH.maxConcurrent }, () => new AbortController());
    fetchMock.mockImplementation(hanging);
    const busy = holders.map((c, i) =>
      withRequestContext({ signal: c.signal }, () => fetchText(`https://developer.magiclane.com/hold-${i}.md`)).catch(
        () => {}
      )
    );
    await vi.advanceTimersByTimeAsync(1);
    const late = fetchText('https://developer.magiclane.com/late-one.md').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs - 1_000); // slots free up 1 s before this one's slot wait ends
    for (const c of holders) c.abort(); // cancelled by their callers: no timeout of the site's
    await Promise.all(busy);
    await vi.advanceTimersByTimeAsync(FETCH.overallTimeoutMs);
    expect(String(await late)).toContain('of queueing'); // cut short by the overall limit
    expect(fetchesHanging()).toBe(false); // nothing remembered: the site was not given its full time
  });

  it('times the network attempt from when it starts, not from when the fetch was queued', async () => {
    vi.useFakeTimers();
    const holders: Array<() => void> = [];
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => holders.push(() => resolve(okResponse('late'))))
    );
    const busy = Array.from({ length: FETCH.maxConcurrent }, (_, i) =>
      fetchText(`https://developer.magiclane.com/hold-${i}.md`)
    );
    const queued = fetchText('https://developer.magiclane.com/patient.md');
    // Queued for most of a timeout, then a slot frees: the attempt is not
    // timed out by the time it spent queued (only by the overall cap).
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs * 0.9);
    (holders.shift() as () => void)();
    await Promise.race(busy);
    await vi.advanceTimersByTimeAsync(FETCH.overallTimeoutMs - FETCH.timeoutMs * 0.9 - 1000);
    expect(fetchMock).toHaveBeenCalledTimes(FETCH.maxConcurrent + 1);
    (holders.pop() as () => void)();
    await expect(queued).resolves.toBe('late');
    for (const release of holders) release();
    await Promise.all(busy);
  });

  it('gives up on a fetch FETCH.overallTimeoutMs after it was queued, slot wait included', async () => {
    vi.useFakeTimers();
    const holders: Array<() => void> = [];
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          holders.push(() => resolve(okResponse('late')));
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const busy = Array.from({ length: FETCH.maxConcurrent }, (_, i) =>
      fetchText(`https://developer.magiclane.com/cap-${i}.md`).catch((e: unknown) => e)
    );
    const queued = fetchText('https://developer.magiclane.com/capped.md');
    const assertion = expect(queued).rejects.toThrow(`No answer within ${FETCH.overallTimeoutMs} ms of queueing`);
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs * 0.9);
    (holders.shift() as () => void)();
    await Promise.race(busy);
    // The attempt has what is left of the overall cap, not a full timeout.
    await vi.advanceTimersByTimeAsync(FETCH.overallTimeoutMs - FETCH.timeoutMs * 0.9 + 1);
    await assertion;
    for (const release of holders) release();
    await Promise.all(busy);
  });

  it('does not send a request for a slot that comes with less than FETCH.minAttemptMs left, and charges nothing for it', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hanging);
    // Shared-file loads (high priority, ahead of the queue) hold every slot in
    // waves, each timing out after 20 s and replaced by the next wave.
    const stop = new AbortController();
    const wave = (n: number): Promise<unknown>[] =>
      Array.from({ length: FETCH.maxConcurrent }, (_, i) =>
        conditionalFetch(`https://developer.magiclane.com/wave-${n}-${i}.md`, undefined, {
          priority: 'high',
          signal: stop.signal,
        }).catch((e: unknown) => e)
      );
    const busy = wave(1);
    // A page of a large batch: it may wait for its slot up to the batch's whole 50 s.
    const late = withRequestContext({ client: 'f', batch: 3 * FETCH.maxActivePerClient }, () =>
      fetchText('https://developer.magiclane.com/floored.md')
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    busy.push(...wave(2));
    await vi.advanceTimersByTimeAsync(20_000);
    busy.push(...wave(3));
    await vi.advanceTimersByTimeAsync(FETCH.batchTimeoutMs - FETCH.minAttemptMs + 1 - 30_000);
    expect(fetchMock).toHaveBeenCalledTimes(3 * FETCH.maxConcurrent); // f's page was never sent
    stop.abort(); // the slots free with under a second of f's time left
    await vi.advanceTimersByTimeAsync(1);
    const err = (await late) as Error;
    expect(err.message).toBe(
      `No outbound slot within ${FETCH.batchTimeoutMs} ms of queueing for https://developer.magiclane.com/floored.md`
    );
    expect(fetchMock).toHaveBeenCalledTimes(3 * FETCH.maxConcurrent); // still: no request went out
    expect(fetchBudgetClients()).toBe(0); // and f's reservation was given back
    expect(isSiteFailure(err, false)).toBe(false);
    await Promise.all(busy);
  });

  it('charges a fetch that reached the site even when its callers leave before the answer', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hanging);
    const stop = new AbortController();
    const asG = (name: string): Promise<unknown> =>
      withRequestContext({ client: 'g', signal: stop.signal }, () =>
        fetchText(`https://developer.magiclane.com/left-early-${name}.md`)
      ).catch((e: unknown) => e);
    const gone = asG('first');
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the request went out
    stop.abort();
    expect(await gone).toBeInstanceOf(RequestCancelledError);
    await vi.advanceTimersByTimeAsync(1);
    // Still charged: a client that abandons each call before the site answers
    // is held to its 120 pages like any other, however many requests it causes.
    expect(fetchBudgetClients()).toBe(1);
    fetchMock.mockImplementation(async (url: string) => okResponse(url));
    const more = (name: string): Promise<unknown> =>
      withRequestContext({ client: 'g' }, () =>
        fetchText(`https://developer.magiclane.com/left-early-${name}.md`)
      ).catch((e: unknown) => e);
    for (let i = 1; i < FETCH.perClientMaxFetches; i++) expect(await more(`m${i}`)).toContain('left-early');
    expect(await more('over')).toBeInstanceOf(FetchBudgetError);
  });

  it('does not send queued pages into the slots a call frees at its deadline, and charges nothing for them', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hanging);
    const as = (name: string, endBy: number): Promise<unknown> =>
      withRequestContext({ client: 'd', endBy }, () =>
        fetchText(`https://developer.magiclane.com/at-deadline-${name}.md`)
      ).catch((e: unknown) => e);
    // One client: a call whose pages hang holds its share and the borrowed
    // slot; a second call's pages queue behind them, with 5 ms more time.
    const running = Array.from({ length: FETCH.maxConcurrent - 1 }, (_, i) => as(`x${i}`, Date.now() + 3_000));
    const queued = ['y0', 'y1', 'y2'].map((name) => as(name, Date.now() + 3_005));
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(FETCH.maxConcurrent - 1);
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent - 1, queued: 3 });
    await vi.advanceTimersByTimeAsync(3_000);
    for (const outcome of await Promise.all(running)) expect(outcome).toBeInstanceOf(FetchDeadlineError);
    // The slots the first call freed came to the queued pages with 5 ms of
    // their own call's time left: not worth a request, so none was sent.
    for (const outcome of await Promise.all(queued)) {
      expect((outcome as Error).message).toMatch(/^No outbound slot within the time left to the calls waiting for /);
      expect(isLoadFailure(outcome)).toBe(true);
      expect(isSiteFailure(outcome, false)).toBe(false);
    }
    expect(fetchMock).toHaveBeenCalledTimes(FETCH.maxConcurrent - 1);
    expect(fetchQueueStats()).toMatchObject({ active: 0, queued: 0 });
    // Charged: the five requests that reached the site, not the three never sent.
    fetchMock.mockImplementation(async (url: string) => okResponse(url));
    for (let i = 0; i < FETCH.perClientMaxFetches - (FETCH.maxConcurrent - 1); i++) {
      expect(await as(`more${i}`, Date.now() + 55_000)).toContain('at-deadline');
    }
    expect(await as('over', Date.now() + 55_000)).toBeInstanceOf(FetchBudgetError);
  });

  it('does not retry a fast 5xx when the overall cap would run out before the retry', async () => {
    vi.useFakeTimers();
    const holders: Array<() => void> = [];
    let late = false;
    fetchMock.mockImplementation((url: string, init: RequestInit) =>
      url.endsWith('/edge.md')
        ? new Promise<Response>((resolve, reject) => {
            late = true;
            setTimeout(() => resolve(errorResponse(503, 'Late')), FETCH.timeoutMs * 0.495);
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
        : new Promise<Response>((resolve) => holders.push(() => resolve(okResponse('x'))))
    );
    const busy = Array.from({ length: FETCH.maxConcurrent }, (_, i) =>
      fetchText(`https://developer.magiclane.com/edge-${i}.md`)
    );
    const edge = fetchText('https://developer.magiclane.com/edge.md');
    const assertion = expect(edge).rejects.toThrow('HTTP 503');
    // Started just before its slot wait ran out, answered 503 within half a
    // timeout: retryable, but too late for the overall cap.
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs - 100);
    (holders.shift() as () => void)();
    await Promise.race(busy);
    expect(late).toBe(true);
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs * 0.495 + 1);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(FETCH.maxConcurrent + 1);
    for (const release of holders) release();
    await Promise.all(busy);
  });

  it('reports an abort for what it was even when undici rejects with something else', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
        })
    );
    const pending = fetchText('https://developer.magiclane.com/slow2.md');
    const assertion = expect(pending).rejects.toThrow(`No answer within ${FETCH.timeoutMs} ms`);
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs + 1);
    await assertion;
  });

  it('drops a leading byte-order mark from the body, as Response.text() would', async () => {
    fetchMock.mockImplementation(async () => okResponse('\uFEFF# Title\n\nBody.'));
    await expect(fetchText('https://developer.magiclane.com/bom.md')).resolves.toBe('# Title\n\nBody.');
  });

  it('seedHttpCache short-circuits the network entirely', async () => {
    seedHttpCache('https://developer.magiclane.com/seeded.md', 'seeded');
    await expect(fetchText('https://developer.magiclane.com/seeded.md')).resolves.toBe('seeded');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clearHttpCache forces a re-fetch', async () => {
    fetchMock.mockImplementation(async () => okResponse('v'));
    await fetchText('https://developer.magiclane.com/e.md');
    clearHttpCache();
    await fetchText('https://developer.magiclane.com/e.md');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('follows a redirect to another page on the documentation host', async () => {
    fetchMock
      .mockResolvedValueOnce(redirectResponse(301, 'https://developer.magiclane.com/moved.md'))
      .mockResolvedValueOnce(okResponse('landed'));
    await expect(fetchText('https://developer.magiclane.com/old.md')).resolves.toBe('landed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('https://developer.magiclane.com/moved.md');
  });

  it('resolves a relative Location against the current URL', async () => {
    // A redirect body that cannot be discarded (locked) is no reason to fail the fetch.
    const redirect = new Response('moved', { status: 302, headers: { location: '/relative.md' } });
    redirect.body?.getReader();
    fetchMock.mockResolvedValueOnce(redirect).mockResolvedValueOnce(okResponse('relative landed'));
    await expect(fetchText('https://developer.magiclane.com/start.md')).resolves.toBe('relative landed');
    expect(fetchMock.mock.calls[1][0]).toBe('https://developer.magiclane.com/relative.md');
  });

  it('refuses to follow a redirect off the documentation host', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse(302, 'https://evil.example/x'));
    await expect(fetchText('https://developer.magiclane.com/bounce.md')).rejects.toThrow(/off the documentation host/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a redirect with no Location header, or an invalid one', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse(301));
    await expect(fetchText('https://developer.magiclane.com/noloc.md')).rejects.toThrow(/without a Location/);
    fetchMock.mockResolvedValueOnce(redirectResponse(301, 'http://[bad'));
    await expect(fetchText('https://developer.magiclane.com/badloc.md')).rejects.toThrow(/invalid Location/);
  });

  it('gives up after too many redirects, and remembers it', async () => {
    fetchMock.mockImplementation(async () => redirectResponse(302, 'https://developer.magiclane.com/loop.md'));
    await expect(fetchText('https://developer.magiclane.com/loop.md')).rejects.toThrow(/Too many redirects/);
    const calls = fetchMock.mock.calls.length;
    await expect(fetchText('https://developer.magiclane.com/loop.md')).rejects.toThrow(/Too many redirects/);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('refuses an XHTML answer as it does HTML', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('<html/>', { 'content-type': 'application/xhtml+xml' }));
    await expect(fetchText('https://developer.magiclane.com/xhtml.md')).rejects.toThrow(/HTML response/);
  });

  it('takes a 429 or 408 for a request to slow down: not retried, not a missing page, kept for its Retry-After', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      async () => new Response('', { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '5' } })
    );
    const first = fetchText('https://developer.magiclane.com/slow-down.md').catch((e: unknown) => e);
    const err = await first;
    expect(String(err)).toContain('HTTP 429');
    expect(isTransientFailure(err)).toBe(true);
    expect(isPermanentFailure(err)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry at once
    await expect(fetchText('https://developer.magiclane.com/slow-down.md')).rejects.toThrow('HTTP 429');
    expect(fetchMock).toHaveBeenCalledTimes(1); // remembered…
    await vi.advanceTimersByTimeAsync(5_001);
    fetchMock.mockResolvedValueOnce(errorResponse(408, 'Request Timeout'));
    await expect(fetchText('https://developer.magiclane.com/slow-down.md')).rejects.toThrow('HTTP 408');
    expect(fetchMock).toHaveBeenCalledTimes(2); // …for its Retry-After only
  });

  it('reads Retry-After as seconds or a date, and caps the memo at the outage memo', () => {
    const now = Date.parse('2026-10-19T10:00:00Z');
    expect(retryAfterMs('7', now)).toBe(7_000);
    expect(retryAfterMs('Mon, 19 Oct 2026 10:00:03 GMT', now)).toBe(3_000);
    expect(retryAfterMs('Mon, 19 Oct 2026 09:00:00 GMT', now)).toBe(0);
    expect(retryAfterMs('soon', now)).toBeUndefined();
    expect(retryAfterMs(null, now)).toBeUndefined();
    expect(retryAfterMs(' ', now)).toBeUndefined();
    expect(failureMemoFor(new Error('x'))).toBe(FETCH.failureMemoMs);
  });

  it('sends redirects manually so each hop can be re-validated', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('x'));
    await fetchText('https://developer.magiclane.com/manual.md');
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).redirect).toBe('manual');
  });

  it('remembers a 404 for a while instead of asking upstream again', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => errorResponse(404, 'Not Found'));
    await expect(fetchText('https://developer.magiclane.com/gone.md')).rejects.toThrow('HTTP 404');
    await expect(fetchText('https://developer.magiclane.com/gone.md')).rejects.toThrow('HTTP 404');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(FETCH.negativeTtlMs + 1);
    await expect(fetchText('https://developer.magiclane.com/gone.md')).rejects.toThrow('HTTP 404');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // A memo set before the wall clock stepped back is over, not longer by the step; so is a cached page's freshness.
    fetchMock.mockImplementation(async () => okResponse('back'));
    vi.setSystemTime(Date.now() - 3_600_000);
    await expect(fetchText('https://developer.magiclane.com/gone.md')).resolves.toBe('back');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(peekCached('https://developer.magiclane.com/gone.md')).toBe('back');
    vi.setSystemTime(Date.now() - 3_600_000);
    expect(peekCached('https://developer.magiclane.com/gone.md')).toBeUndefined();
    await expect(fetchText('https://developer.magiclane.com/gone.md')).resolves.toBe('back');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('keeps the failure memo bounded: expired entries are swept, and the oldest go when it is full', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => errorResponse(404, 'Not Found'));
    const gone = (i: number): string => `https://developer.magiclane.com/gone-${i}.md`;
    for (let i = 0; i < FETCH.maxNegativeEntries + 5; i++) await expect(fetchText(gone(i))).rejects.toThrow('HTTP 404');
    expect(cacheStats().failures).toBe(FETCH.maxNegativeEntries);
    // The five oldest were dropped: asking again fetches; the newest is still remembered.
    const calls = fetchMock.mock.calls.length;
    await expect(fetchText(gone(0))).rejects.toThrow('HTTP 404');
    expect(fetchMock.mock.calls.length).toBe(calls + 1);
    await expect(fetchText(gone(FETCH.maxNegativeEntries + 4))).rejects.toThrow('HTTP 404');
    expect(fetchMock.mock.calls.length).toBe(calls + 1);
    expect(cacheStats().failures).toBe(FETCH.maxNegativeEntries);
    // Expired entries leave with the sweep, without being asked for again.
    sweepFetchBudgets();
    expect(cacheStats().failures).toBe(FETCH.maxNegativeEntries);
    vi.advanceTimersByTime(FETCH.negativeTtlMs + 1);
    sweepFetchBudgets();
    expect(cacheStats().failures).toBe(0);
  });

  it('refuses HTML answers as permanent failures', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('<html>', { 'content-type': 'text/html; charset=utf-8' }));
    const err = await fetchText('https://developer.magiclane.com/shell.md').catch((e: unknown) => e);
    expect((err as Error).message).toContain('Not a documentation page (HTML response)');
    expect(isPermanentFailure(err)).toBe(true);
    expect(isTransientFailure(err)).toBe(false);
  });

  it('serves a stale body when the refresh fails with a network error', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(okResponse('kept'));
    await fetchText('https://developer.magiclane.com/stale.md');
    vi.advanceTimersByTime(CACHE.ttlMs + 1);
    fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') }));
    const pending = fetchText('https://developer.magiclane.com/stale.md');
    await vi.advanceTimersByTimeAsync(FETCH.retryDelayMs + 1);
    await expect(pending).resolves.toBe('kept');
  });

  it('treats only undici network errors as transient TypeErrors', () => {
    expect(isTransientFailure(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientFailure(Object.assign(new TypeError('x'), { cause: 1 }))).toBe(true);
    expect(isTransientFailure(new TypeError('Invalid URL'))).toBe(false);
    // A cancellation is not an upstream failure (a timeout is a TransientError of its own).
    expect(isTransientFailure(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(false);
    expect(isTransientFailure('nope')).toBe(false);
  });

  it('rejects an unexpected 304 when no validators were sent, instead of crashing', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 304,
      statusText: 'Not Modified',
      headers: new Headers(),
      text: async () => '',
    });
    const pending = fetchText('https://developer.magiclane.com/odd.md');
    const assertion = expect(pending).rejects.toThrow('Unexpected 304');
    await assertion;
  });

  it('exposes conditionalFetch for memo callers, answering unchanged on 304', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 304,
      statusText: 'Not Modified',
      headers: new Headers(),
      text: async () => '',
    });
    await expect(conditionalFetch('https://developer.magiclane.com/c.md', { etag: '"e"' })).resolves.toEqual({
      status: 'unchanged',
    });
  });

  it('counts cache bytes in UTF-8, not UTF-16 units', () => {
    seedHttpCache('https://developer.magiclane.com/utf.md', '😀'); // 2 UTF-16 units, 4 bytes
    expect(cacheStats().bytes).toBe(4);
  });

  it('evicts the least recently USED entry, not the oldest inserted', async () => {
    fetchMock.mockImplementation(async (url: string) => okResponse(`body:${url}`));
    for (let i = 0; i < CACHE.maxEntries; i++) await fetchText(`https://developer.magiclane.com/lru-${i}.md`);
    await fetchText('https://developer.magiclane.com/lru-0.md'); // touch the oldest
    await fetchText('https://developer.magiclane.com/lru-extra.md'); // evicts lru-1 now
    fetchMock.mockClear();
    await fetchText('https://developer.magiclane.com/lru-0.md');
    expect(fetchMock).not.toHaveBeenCalled();
    await fetchText('https://developer.magiclane.com/lru-1.md');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('starts the timeout when a fetch is queued, so time spent waiting for a slot counts', async () => {
    vi.useFakeTimers();
    // These hold their slots past the timeout: they ignore the abort.
    const holders: Array<() => void> = [];
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => holders.push(() => resolve(okResponse('late'))))
    );
    const busy = Array.from({ length: FETCH.maxConcurrent }, (_, i) =>
      fetchText(`https://developer.magiclane.com/busy-${i}.md`).catch((e: unknown) => e)
    );
    const queued = fetchText('https://developer.magiclane.com/queued.md');
    const assertion = expect(queued).rejects.toThrow(`No outbound slot within ${FETCH.timeoutMs} ms`);
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent, queued: 1 });
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs + 1);
    await assertion;
    for (const release of holders) release();
    await Promise.all(busy);
    // The queued fetch timed out without ever reaching the network.
    expect(fetchMock).toHaveBeenCalledTimes(FETCH.maxConcurrent);
    expect(fetchQueueStats()).toMatchObject({ active: 0, queued: 0 });
    // It says nothing about the site, so it is not remembered as a failure: asked again, it is fetched.
    fetchMock.mockImplementation(async () => okResponse('now'));
    await expect(fetchText('https://developer.magiclane.com/queued.md')).resolves.toBe('now');
    // A load failure, as read_docs_batch tells them apart; a page's own failure is not one.
    expect(isLoadFailure(await queued.catch((e: unknown) => e))).toBe(true);
    expect(isLoadFailure(new FetchBusyError('full'))).toBe(true);
    expect(isLoadFailure(new Error('HTTP 404'))).toBe(false);
  });

  it('refuses page fetches beyond the queue bound, while index fetches still queue and go first', async () => {
    const releases: Array<() => void> = [];
    const order: string[] = [];
    fetchMock.mockImplementation(
      (url: string) =>
        new Promise<Response>((resolve) => {
          order.push(url);
          releases.push(() => resolve(okResponse(url)));
        })
    );
    const page = (i: number): string => `https://developer.magiclane.com/q-${i}.md`;
    const running = Array.from({ length: FETCH.maxConcurrent + FETCH.maxQueued }, (_, i) => fetchText(page(i)));
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent, queued: FETCH.maxQueued });
    const refused = fetchText(page(9999));
    await expect(refused).rejects.toBeInstanceOf(FetchBusyError);
    await expect(refused).rejects.toThrow('retry in a few seconds');
    const index = conditionalFetch('https://developer.magiclane.com/docs/llms.txt', undefined, {
      priority: 'high',
    });
    const index2 = conditionalFetch('https://developer.magiclane.com/docs/flutter/llms.txt', undefined, {
      priority: 'high',
    });
    expect(fetchQueueStats().queued).toBe(FETCH.maxQueued + 2);
    // Freeing slots serves the high-priority fetches first, in their own order.
    while (releases.length > 0) {
      (releases.shift() as () => void)();
      await new Promise((r) => setImmediate(r));
    }
    await Promise.all([...running, index, index2]);
    expect(order[FETCH.maxConcurrent]).toBe('https://developer.magiclane.com/docs/llms.txt');
    expect(order[FETCH.maxConcurrent + 1]).toBe('https://developer.magiclane.com/docs/flutter/llms.txt');
  });

  it('stops waiting when the request is cancelled, and aborts a download nobody waits for', async () => {
    fetchMock.mockImplementation(hanging);
    const controller = new AbortController();
    const pending = withRequestContext({ signal: controller.signal }, () =>
      fetchText('https://developer.magiclane.com/cancel.md')
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(RequestCancelledError);
    await vi.waitFor(() => expect(init.signal?.aborted).toBe(true));
    await vi.waitFor(() => expect(fetchQueueStats().active).toBe(0));
  });

  it('keeps a shared download alive while another request still waits for it', async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) => {
          release = resolve;
          init.signal?.addEventListener('abort', () => resolve(errorResponse(599, 'aborted')));
        })
    );
    const leaving = new AbortController();
    const first = withRequestContext({ signal: leaving.signal }, () =>
      fetchText('https://developer.magiclane.com/shared.md')
    );
    const second = withRequestContext({ signal: new AbortController().signal }, () =>
      fetchText('https://developer.magiclane.com/shared.md')
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    leaving.abort();
    await expect(first).rejects.toBeInstanceOf(RequestCancelledError);
    release(okResponse('still wanted'));
    await expect(second).resolves.toBe('still wanted');
  });

  it('does not start a fetch for a request that is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      withRequestContext({ signal: controller.signal }, () => fetchText('https://developer.magiclane.com/never.md'))
    ).rejects.toBeInstanceOf(RequestCancelledError);
    await expect(
      conditionalFetch('https://developer.magiclane.com/never2.md', undefined, { signal: controller.signal })
    ).rejects.toBeInstanceOf(RequestCancelledError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not retry a 5xx for a request cancelled meanwhile', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      controller.abort();
      return errorResponse(503, 'Unavailable');
    });
    await expect(
      conditionalFetch('https://developer.magiclane.com/x5.md', undefined, { signal: controller.signal })
    ).rejects.toBeInstanceOf(RequestCancelledError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serves the stale copy at once while the host is remembered as down', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(okResponse('old'));
    await fetchText('https://developer.magiclane.com/down.md');
    vi.advanceTimersByTime(CACHE.ttlMs + 1);
    fetchMock.mockImplementation(async () => errorResponse(503, 'Unavailable'));
    const first = fetchText('https://developer.magiclane.com/down.md');
    await vi.advanceTimersByTimeAsync(FETCH.retryDelayMs + 1);
    await expect(first).resolves.toBe('old');
    await expect(fetchText('https://developer.magiclane.com/down.md')).resolves.toBe('old');
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 original + 2 for the failed refresh
  });

  it('serves the stale copy when a refresh is slow, and keeps the refreshed one', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(okResponse('old'));
    await fetchText('https://developer.magiclane.com/slowrefresh.md');
    vi.advanceTimersByTime(CACHE.ttlMs + 1);
    let release!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));
    const pending = fetchText('https://developer.magiclane.com/slowrefresh.md');
    await vi.advanceTimersByTimeAsync(FETCH.staleGraceMs + 1);
    await expect(pending).resolves.toBe('old');
    release(okResponse('new'));
    await vi.waitFor(() => expect(peekCached('https://developer.magiclane.com/slowrefresh.md')).toBe('new'));
  });

  it('serves the stale copy, not a deadline error, to a call with less than the stale grace left', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(okResponse('old'));
    await fetchText('https://developer.magiclane.com/late.md');
    vi.advanceTimersByTime(CACHE.ttlMs + 1);
    fetchMock.mockImplementation(hanging);
    const pending = withRequestContext({ endBy: Date.now() + 3_000 }, () =>
      fetchText('https://developer.magiclane.com/late.md')
    );
    await vi.advanceTimersByTimeAsync(3_001);
    await expect(pending).resolves.toBe('old');
    await vi.advanceTimersByTimeAsync(FETCH.overallTimeoutMs);
  });

  it('gives each HTTP client a budget of uncached page fetches; cache hits and stdio are free', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (url: string) => okResponse(url));
    const asClient = (client: string, i: number): Promise<string> =>
      withRequestContext({ client }, () => fetchText(`https://developer.magiclane.com/b-${client}-${i}.md`));
    for (let i = 0; i < FETCH.perClientMaxFetches; i++) await asClient('a', i);
    await expect(asClient('a', 0)).resolves.toContain('b-a-0'); // cached: free
    const over = asClient('a', 'x' as unknown as number);
    await expect(over).rejects.toBeInstanceOf(FetchBudgetError);
    await expect(over).rejects.toThrow(
      `(${FETCH.perClientMaxFetches} per ${FETCH.perClientWindowMs / 1000} s); retry in 60 s`
    );
    await expect(asClient('b', 0)).resolves.toContain('b-b-0');
    await expect(fetchText('https://developer.magiclane.com/stdio.md')).resolves.toContain('stdio');
    sweepFetchBudgets(); // live windows stay
    await expect(asClient('a', 'y' as unknown as number)).rejects.toBeInstanceOf(FetchBudgetError);
    vi.advanceTimersByTime(FETCH.perClientWindowMs);
    sweepFetchBudgets();
    await expect(asClient('a', 'z' as unknown as number)).resolves.toContain('b-a-z');
  });

  it('charges the page budget only for fetches that start, not for ones refused or abandoned in the queue', async () => {
    fetchMock.mockImplementation(hanging);
    const stop = new AbortController();
    const as = (client: string | undefined, url: string): Promise<unknown> =>
      withRequestContext({ client, signal: stop.signal }, () => fetchText(url)).catch((e: unknown) => e);
    const page = (name: string): string => `https://developer.magiclane.com/c7-${name}.md`;
    // The slots are held by fetches without a client (stdio), which have no share to stay within.
    const pending = Array.from({ length: FETCH.maxConcurrent }, (_, i) => as(undefined, page(`a${i}`)));
    for (let i = 0; i < FETCH.maxQueuedPerClient; i++) pending.push(as('c', page(`q${i}`)));
    await Promise.resolve();
    // Far more refusals than the whole budget: none of them may count.
    for (let i = 0; i < FETCH.perClientMaxFetches + 5; i++) {
      expect(await as('c', page(`r${i}`))).toBeInstanceOf(FetchBusyError);
    }
    expect(fetchBudgetClients()).toBe(1); // c's queued pages hold reservations
    stop.abort();
    await Promise.all(pending);
    await vi.waitFor(() => expect(fetchQueueStats()).toMatchObject({ active: 0, queued: 0 }));
    expect(fetchBudgetClients()).toBe(0); // all given back: a client that started nothing leaves no window
    fetchMock.mockImplementation(async (url: string) => okResponse(url));
    await expect(withRequestContext({ client: 'c' }, () => fetchText(page('after')))).resolves.toContain('c7-after');
  });

  it('keeps the budgets of a bounded number of clients: the oldest window makes room', async () => {
    fetchMock.mockImplementation(async (url: string) => okResponse(url));
    limitFetchBudgetClients(3);
    try {
      const page = (name: string): string => `https://developer.magiclane.com/cap-${name}.md`;
      for (const client of ['a', 'b', 'c', 'd']) {
        await withRequestContext({ client }, () => fetchText(page(client)));
      }
      expect(fetchBudgetClients()).toBe(3); // a's window made room for d's
      // A client with a window keeps its place in it, whatever the others do.
      await withRequestContext({ client: 'b' }, () => fetchText(page('b2')));
      await withRequestContext({ client: 'e' }, () => fetchText(page('e')));
      expect(fetchBudgetClients()).toBe(3);
      await expect(withRequestContext({ client: 'b' }, () => fetchText(page('b3')))).resolves.toContain('cap-b3');
    } finally {
      limitFetchBudgetClients();
    }
  });

  it('hands freed outbound slots round-robin across clients, so one batch cannot hold up another page', async () => {
    const order: string[] = [];
    const finish = new Map<string, () => void>();
    fetchMock.mockImplementation((url: string) => {
      order.push(url.replace('https://developer.magiclane.com/rr-', '').replace('.md', ''));
      return new Promise<Response>((resolve) => finish.set(url, () => resolve(okResponse(url))));
    });
    const as = (client: string | undefined, name: string): Promise<string> =>
      withRequestContext({ client }, () => fetchText(`https://developer.magiclane.com/rr-${name}.md`));
    // The slots are held by fetches without a client (stdio); a and b queue behind them.
    const all = Array.from({ length: FETCH.maxConcurrent }, (_, i) => as(undefined, `run${i}`));
    for (let i = 0; i < 4; i++) all.push(as('a', `q${i}`));
    all.push(as('b', 'b0'));
    await vi.waitFor(() => expect(order).toHaveLength(FETCH.maxConcurrent));
    const done = (name: string): void => finish.get(`https://developer.magiclane.com/rr-${name}.md`)!();
    done('run0'); // first freed slot: a's oldest queued page (a was never served from the queue)
    await vi.waitFor(() => expect(order).toHaveLength(FETCH.maxConcurrent + 1));
    done('run1'); // next: b, which waited behind four of a's pages
    await vi.waitFor(() => expect(order).toHaveLength(FETCH.maxConcurrent + 2));
    expect(order.slice(FETCH.maxConcurrent)).toEqual(['q0', 'b0']);
    for (const name of ['run2', 'run3', 'run4', 'run5', 'q0', 'b0']) done(name);
    await vi.waitFor(() => expect(order).toHaveLength(FETCH.maxConcurrent + 5));
    for (const name of ['q1', 'q2', 'q3']) done(name);
    await Promise.all(all);
    expect(fetchQueueStats()).toMatchObject({ active: 0, queued: 0 });
  });

  it("does not let a client that keeps one page waiting starve another client's batch", async () => {
    const order: string[] = [];
    const finish = new Map<string, () => void>();
    fetchMock.mockImplementation((url: string) => {
      order.push(url.replace('https://developer.magiclane.com/sv-', '').replace('.md', ''));
      return new Promise<Response>((resolve) => finish.set(url, () => resolve(okResponse(url))));
    });
    const as = (client: string | undefined, name: string): Promise<string> =>
      withRequestContext({ client }, () => fetchText(`https://developer.magiclane.com/sv-${name}.md`));
    const done = (name: string): void => finish.get(`https://developer.magiclane.com/sv-${name}.md`)!();
    // The slots are held by stdio fetches and a page of a third client, c: with
    // three clients running pages, the last free slot is not kept from them.
    const all = Array.from({ length: FETCH.maxConcurrent - 1 }, (_, i) => as(undefined, `run${i}`));
    all.push(as('c', 'c0'));
    for (let i = 0; i < 3; i++) all.push(as('a', `q${i}`));
    all.push(as('b', 'b0'));
    await vi.waitFor(() => expect(order).toHaveLength(FETCH.maxConcurrent));
    done('run0');
    await vi.waitFor(() => expect(order).toHaveLength(FETCH.maxConcurrent + 1));
    done('run1');
    await vi.waitFor(() => expect(order).toHaveLength(FETCH.maxConcurrent + 2));
    // b's next page arrives just after its last one got a slot: a newcomer to
    // the queue again, but not ahead of a, which was served longer ago.
    all.push(as('b', 'b1'));
    done('run2');
    await vi.waitFor(() => expect(order).toHaveLength(FETCH.maxConcurrent + 3));
    done('run3');
    await vi.waitFor(() => expect(order).toHaveLength(FETCH.maxConcurrent + 4));
    expect(order.slice(FETCH.maxConcurrent)).toEqual(['q0', 'b0', 'q1', 'b1']);
    for (const name of ['run4', 'c0', 'q0', 'b0', 'q1', 'b1']) done(name);
    await vi.waitFor(() => expect(order).toHaveLength(FETCH.maxConcurrent + 5));
    done('q2');
    await Promise.all(all);
  });

  it('reserves the page budget when a fetch is queued, so a burst cannot overshoot it', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (url: string) => okResponse(url));
    const as = (i: number): Promise<unknown> =>
      withRequestContext({ client: 'burst' }, () => fetchText(`https://developer.magiclane.com/burst-${i}.md`)).catch(
        (e: unknown) => e
      );
    for (let i = 0; i < FETCH.perClientMaxFetches - 3; i++) await as(i);
    const outcomes = await Promise.all(Array.from({ length: 10 }, (_, i) => as(1000 + i)));
    expect(outcomes.filter((o) => o instanceof FetchBudgetError)).toHaveLength(7);
  });

  it('gives a reservation back only to the window it was taken from', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    fetchMock.mockImplementation(hanging);
    const stop = new AbortController();
    const page = (name: string): string => `https://developer.magiclane.com/rw-${name}.md`;
    // The slots are held by fetches without a client (stdio), which lend none: r's pages queue.
    const busy = Array.from({ length: FETCH.maxConcurrent }, (_, i) =>
      withRequestContext({ signal: stop.signal }, () => fetchText(page(`x${i}`))).catch((e: unknown) => e)
    );
    const queued = (name: string, signal: AbortSignal): Promise<unknown> =>
      withRequestContext({ client: 'r', signal }, () => fetchText(page(name))).catch((e: unknown) => e);
    // Swept before the queued fetch gives up: nothing to give back to.
    const first = new AbortController();
    const a = queued('a', first.signal);
    await Promise.resolve();
    vi.setSystemTime(Date.now() + FETCH.perClientWindowMs);
    sweepFetchBudgets();
    first.abort();
    expect(await a).toBeInstanceOf(RequestCancelledError);
    // A newer window started meanwhile: it keeps its count.
    const second = new AbortController();
    const b = queued('b', second.signal);
    await Promise.resolve();
    vi.setSystemTime(Date.now() + FETCH.perClientWindowMs);
    const third = new AbortController();
    const c = queued('c', third.signal); // opens the new window, count 1
    await Promise.resolve();
    second.abort();
    expect(await b).toBeInstanceOf(RequestCancelledError);
    third.abort();
    await c;
    stop.abort();
    await Promise.all(busy);
    await vi.waitFor(() => expect(fetchQueueStats()).toMatchObject({ active: 0, queued: 0 }));
  });

  it('lets a client alone use the idle slots but one, and only its share while another client waits', async () => {
    const finish = new Map<string, () => void>();
    const order: string[] = [];
    fetchMock.mockImplementation((url: string) => {
      order.push(url.replace('https://developer.magiclane.com/act-', '').replace('.md', ''));
      return new Promise<Response>((resolve) => finish.set(url, () => resolve(okResponse(url))));
    });
    const as = (client: string | undefined, name: string): Promise<string> =>
      withRequestContext({ client }, () => fetchText(`https://developer.magiclane.com/act-${name}.md`));
    const done = (name: string): void => finish.get(`https://developer.magiclane.com/act-${name}.md`)!();
    // Alone, a runs past its share, into every idle slot but one.
    const all = Array.from({ length: FETCH.maxConcurrent + 2 }, (_, i) => as('a', `a${i}`));
    await vi.waitFor(() => expect(order).toHaveLength(FETCH.maxConcurrent - 1));
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent - 1, queued: 3 });
    // A slot frees: a's next page borrows it again.
    done('a0');
    await vi.waitFor(() => expect(order).toHaveLength(FETCH.maxConcurrent));
    expect(order.at(-1)).toBe(`a${FETCH.maxConcurrent - 1}`);
    // The slot left is b's at once; b's next page waits.
    all.push(as('b', 'b0'), as('b', 'b1'));
    await vi.waitFor(() => expect(order).toHaveLength(FETCH.maxConcurrent + 1));
    expect(order.at(-1)).toBe('b0');
    // A slot frees: a runs past its share and b waits, so b goes next.
    done('a1');
    await vi.waitFor(() => expect(order).toHaveLength(FETCH.maxConcurrent + 2));
    expect(order.at(-1)).toBe('b1');
    // Below its share again, a takes the next one.
    done('a2');
    await vi.waitFor(() => expect(order).toHaveLength(FETCH.maxConcurrent + 3));
    expect(order.at(-1)).toBe(`a${FETCH.maxConcurrent}`);
    for (const name of [...finish.keys()]) finish.get(name)!();
    await vi.waitFor(() => expect(order).toHaveLength(FETCH.maxConcurrent + 4));
    for (const name of [...finish.keys()]) finish.get(name)!();
    await Promise.all(all);
    expect(fetchQueueStats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('keeps the last free slot from two clients from their first pages on: two never hold every slot', async () => {
    fetchMock.mockImplementation((url: string, init: RequestInit) =>
      url.includes('/two-v') ? Promise.resolve(okResponse('answered')) : hanging(url, init)
    );
    const stop = new AbortController();
    const first = new AbortController();
    const as = (client: string, name: string, signal = stop.signal): Promise<unknown> =>
      withRequestContext({ client, signal }, () => fetchText(`https://developer.magiclane.com/two-${name}.md`)).catch(
        (e: unknown) => e
      );
    // Four single pages from each of two clients, at once: nothing hangs yet,
    // nothing is borrowed, and still the last slot stays free.
    const all = [as('a', 'a0', first.signal), as('a', 'a1'), as('a', 'a2'), as('a', 'a3')];
    all.push(...['b0', 'b1', 'b2', 'b3'].map((name) => as('b', name)));
    await Promise.resolve();
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent - 1, queued: 3 });
    await expect(as('v', 'v0')).resolves.toBe('answered'); // a newcomer gets it at once
    await Promise.resolve();
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent - 1, queued: 3 });
    // With a third client running a page, a slot that frees is not kept from them.
    all.push(as('c', 'c0'));
    await Promise.resolve();
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent, queued: 3 });
    first.abort();
    await vi.waitFor(() => expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent, queued: 2 }));
    stop.abort();
    await Promise.all(all);
    await vi.waitFor(() => expect(fetchQueueStats()).toMatchObject({ active: 0, queued: 0 }));
  });

  it('keeps the last free slot, while pages hang, for a client running nothing yet', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    fetchMock.mockImplementation(hanging);
    const stop = new AbortController();
    const started: string[] = [];
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      started.push(url.replace('https://developer.magiclane.com/hang-', '').replace('.md', ''));
      return hanging(url, init);
    });
    const as = (client: string, name: string): Promise<unknown> =>
      withRequestContext({ client, signal: stop.signal }, () =>
        fetchText(`https://developer.magiclane.com/hang-${name}.md`)
      ).catch((e: unknown) => e);
    const all = Array.from({ length: FETCH.maxActivePerClient }, (_, i) => as('a', `a${i}`));
    await vi.waitFor(() => expect(started).toHaveLength(FETCH.maxActivePerClient));
    vi.setSystemTime(Date.now() + FETCH.slowFetchMs + 1); // a's pages hang
    // Alone, a would borrow an idle slot — not while its pages hang.
    all.push(as('a', 'a-more'));
    await Promise.resolve();
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxActivePerClient, queued: 1 });
    all.push(as('b', 'b0'), as('b', 'b1'));
    await vi.waitFor(() => expect(started).toContain('b0'));
    await Promise.resolve();
    // One slot is free, but b already runs a page: it is kept for a newcomer.
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent - 1, queued: 2 });
    all.push(as('c', 'c0'));
    await vi.waitFor(() => expect(started).toContain('c0'));
    expect(started).not.toContain('b1');
    expect(started).not.toContain('a-more');
    stop.abort();
    await Promise.all(all);
    await vi.waitFor(() => expect(fetchQueueStats()).toMatchObject({ active: 0, queued: 0 }));
  });

  it('keeps the last free slot for newcomers after the hanging pages time out together, even once one is answered', async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      started.push(url.replace('https://developer.magiclane.com/round-', '').replace('.md', ''));
      return url.includes('/round-v') ? Promise.resolve(okResponse('answered')) : hanging(url, init);
    });
    const stop = new AbortController();
    const as = (client: string, name: string): Promise<unknown> =>
      withRequestContext({ client, signal: stop.signal }, () =>
        fetchText(`https://developer.magiclane.com/round-${name}.md`)
      ).catch((e: unknown) => e);
    // Three clients' hanging pages hold every slot (a's share, and one each for
    // b and c, which were running nothing yet), then time out together.
    const all = [
      ...Array.from({ length: FETCH.maxActivePerClient }, (_, i) => as('a', `a${i}`)),
      as('b', 'b0'),
      as('c', 'c0'),
    ];
    await vi.waitFor(() => expect(started).toHaveLength(FETCH.maxConcurrent));
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs + 1);
    expect(fetchQueueStats()).toMatchObject({ active: 0, queued: 0 });
    // Their next pages, at once, the three running pages again: no fetch hangs
    // at this instant, but the site just left six unanswered — the last slot
    // stays kept.
    all.push(as('c', 'c-0'), as('c', 'c-1'), as('b', 'b-0'));
    all.push(...Array.from({ length: FETCH.maxActivePerClient }, (_, i) => as('a', `a-${i}`)));
    await vi.waitFor(() => expect(fetchQueueStats().active).toBe(FETCH.maxConcurrent - 1));
    await Promise.resolve();
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent - 1, queued: 2 });
    expect(fetchesHanging()).toBe(true);
    const victim = as('v', 'v-first');
    await vi.waitFor(() => expect(started).toContain('v-first')); // without waiting for a timeout
    expect(await victim).toBe('answered');
    // Its answer ends /health's "hanging" reason, but not the slot rule's memo:
    // a's queued pages do not get the slot it freed — one answered page says
    // nothing about theirs — so v's next page gets it at once too.
    expect(fetchesHanging()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent - 1, queued: 2 });
    all.push(as('v', 'v-second'));
    await vi.waitFor(() => expect(started).toContain('v-second'));
    stop.abort();
    await Promise.all(all);
    await vi.waitFor(() => expect(fetchQueueStats()).toMatchObject({ active: 0, queued: 0 }));
  });

  it('lends the slot a client borrowed when alone to a client running nothing yet, at once and once', async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      started.push(url.replace('https://developer.magiclane.com/lend-', '').replace('.md', ''));
      return hanging(url, init);
    });
    const stop = new AbortController();
    const as = (client: string, name: string): Promise<unknown> =>
      withRequestContext({ client, signal: stop.signal }, () =>
        fetchText(`https://developer.magiclane.com/lend-${name}.md`)
      ).catch((e: unknown) => e);
    // Alone, a takes its share and borrows one more — never a second one.
    const all = Array.from({ length: FETCH.maxConcurrent }, (_, i) => as('a', `a${i}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent - 1, queued: 1 });
    // b takes the last of the six; its next page waits: the slot a borrowed
    // is not one for a client already running a page.
    all.push(as('b', 'b0'), as('b', 'b1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent, queued: 2 });
    // c, running nothing, gets it at once — a seventh fetch — without waiting
    // for a's pages to hang; a fourth client waits: the lent slot is one.
    all.push(as('c', 'c0'));
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toContain('c0');
    expect(started).not.toContain('b1');
    expect(started).not.toContain(`a${FETCH.maxConcurrent - 1}`);
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent + 1, queued: 2 });
    all.push(as('d', 'd0'));
    await vi.advanceTimersByTimeAsync(FETCH.slowFetchMs + 1);
    expect(started).not.toContain('d0');
    stop.abort();
    await Promise.all(all);
    await vi.waitFor(() => expect(fetchQueueStats()).toMatchObject({ active: 0, queued: 0 }));
  });

  it('runs background reloads a few at a time, after the calls, and always leaves a slot free', async () => {
    fetchMock.mockImplementation(hanging);
    const stop = new AbortController();
    const background = (i: number): Promise<unknown> =>
      conditionalFetch(`https://developer.magiclane.com/bg-${i}/llms.txt`, undefined, {
        priority: 'background',
        signal: stop.signal,
      }).catch((e: unknown) => e);
    const stdio = (i: number): Promise<unknown> =>
      withRequestContext({ signal: stop.signal }, () => fetchText(`https://developer.magiclane.com/io-${i}.md`)).catch(
        (e: unknown) => e
      );
    const all = [0, 1, 2].map(background);
    await Promise.resolve();
    expect(fetchQueueStats()).toMatchObject({
      active: FETCH.maxBackgroundFetches,
      queued: 3 - FETCH.maxBackgroundFetches,
    });
    for (let i = 0; i < FETCH.maxConcurrent - FETCH.maxBackgroundFetches; i++) all.push(stdio(i));
    await Promise.resolve();
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent, queued: 1 });
    stop.abort();
    await Promise.all(all);
    await vi.waitFor(() => expect(fetchQueueStats()).toMatchObject({ active: 0, queued: 0 }));
    // A free slot that is the last one is not a background reload's.
    const again = new AbortController();
    const more = Array.from({ length: FETCH.maxConcurrent - 1 }, (_, i) =>
      withRequestContext({ signal: again.signal }, () =>
        fetchText(`https://developer.magiclane.com/io2-${i}.md`)
      ).catch((e: unknown) => e)
    );
    more.push(
      conditionalFetch('https://developer.magiclane.com/bg-last/llms.txt', undefined, {
        priority: 'background',
        signal: again.signal,
      }).catch((e: unknown) => e)
    );
    await Promise.resolve();
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent - 1, queued: 1 });
    again.abort();
    await Promise.all(more);
  });

  it('hands a freed slot to a waiting page before a waiting background reload', async () => {
    const finish = new Map<string, () => void>();
    const order: string[] = [];
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      order.push(url.replace('https://developer.magiclane.com/', ''));
      return url.includes('/first-')
        ? new Promise<Response>((resolve) => finish.set(url, () => resolve(okResponse(url))))
        : hanging(url, init);
    });
    const stop = new AbortController();
    const pages = Array.from({ length: FETCH.maxConcurrent }, (_, i) =>
      withRequestContext({ signal: stop.signal }, () => fetchText(`https://developer.magiclane.com/first-${i}.md`))
    );
    await vi.waitFor(() => expect(finish.size).toBe(FETCH.maxConcurrent));
    const reload = conditionalFetch('https://developer.magiclane.com/reload/llms.txt', undefined, {
      priority: 'background',
      signal: stop.signal,
    }).catch((e: unknown) => e);
    const page = withRequestContext({ signal: stop.signal }, () =>
      fetchText('https://developer.magiclane.com/second.md')
    ).catch((e: unknown) => e);
    await Promise.resolve();
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent, queued: 2 });
    for (const done of finish.values()) done();
    await Promise.all(pages);
    await vi.waitFor(() => expect(order).toHaveLength(FETCH.maxConcurrent + 2));
    expect(order.slice(FETCH.maxConcurrent)).toEqual(['second.md', 'reload/llms.txt']);
    stop.abort();
    await Promise.all([reload, page]);
  });

  it('hands a background turn on once its reload has had no answer for FETCH.slowFetchMs, two at most, beside the slots', async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    const answers: Array<() => void> = [];
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      started.push(url.replace('https://developer.magiclane.com/', ''));
      if (url.includes('/hang-')) return hanging(url, init);
      if (url.includes('/call-'))
        return new Promise<Response>((resolve) => answers.push(() => resolve(okResponse('call'))));
      return Promise.resolve(okResponse('fine'));
    });
    const reload = (name: string): Promise<unknown> =>
      conditionalFetch(`https://developer.magiclane.com/${name}/llms.txt`, undefined, { priority: 'background' }).catch(
        (e: unknown) => e
      );
    const hangs = ['hang-a', 'hang-b', 'hang-c', 'hang-d'].map(reload);
    const fine = reload('fine');
    await vi.advanceTimersByTimeAsync(FETCH.slowFetchMs - 1);
    expect(started).toEqual(['hang-a/llms.txt', 'hang-b/llms.txt']);
    await vi.advanceTimersByTimeAsync(1); // a and b have had no answer for 5 s: they hand their turns on
    expect(started).toEqual(['hang-a/llms.txt', 'hang-b/llms.txt', 'hang-c/llms.txt', 'hang-d/llms.txt']);
    await vi.advanceTimersByTimeAsync(FETCH.slowFetchMs); // c and d hang too, but two turns are handed on at most
    expect(started).toHaveLength(4);
    // The calls keep the slots they had: the hanging reloads run beside them.
    const calls = Array.from({ length: FETCH.maxConcurrent - FETCH.maxBackgroundFetches }, (_, i) =>
      fetchText(`https://developer.magiclane.com/call-${i}.md`)
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent + FETCH.maxBackgroundFetches, queued: 1 });
    for (const answer of answers) answer();
    await Promise.all(calls);
    // When a and b time out, c and d hand on theirs: the file that waited gets its turn.
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs - 2 * FETCH.slowFetchMs);
    expect(started.at(-1)).toBe('fine/llms.txt');
    expect(await fine).toMatchObject({ status: 'fresh' });
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs);
    for (const err of await Promise.all(hangs)) expect(String(err)).toContain(`No answer within ${FETCH.timeoutMs} ms`);
  });

  it('keeps a background turn while the reload holding it has had its answer, however slow its body', async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    const finish: Array<() => void> = [];
    fetchMock.mockImplementation((url: string) => {
      started.push(url.replace('https://developer.magiclane.com/', ''));
      if (!url.includes('/slow-')) return Promise.resolve(okResponse('fine'));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(4).fill(120)); // the answer and a first chunk, then nothing for a while
          finish.push(() => controller.close());
        },
      });
      return Promise.resolve(new Response(body, { status: 200, statusText: 'OK' }));
    });
    const reload = (name: string): Promise<unknown> =>
      conditionalFetch(`https://developer.magiclane.com/${name}/llms.txt`, undefined, { priority: 'background' }).catch(
        (e: unknown) => e
      );
    const slow = ['slow-a', 'slow-b'].map(reload);
    const next = reload('next');
    await vi.advanceTimersByTimeAsync(2 * FETCH.slowFetchMs);
    expect(started).toEqual(['slow-a/llms.txt', 'slow-b/llms.txt']); // answered: they do not hang
    for (const done of finish) done();
    await Promise.all(slow);
    await expect(next).resolves.toMatchObject({ status: 'fresh' });
  });

  it("runs a shared download on the fetch's own limits: a caller out of time leaves alone, nothing is remembered", async () => {
    vi.useFakeTimers();
    // The site answers in 3 s, and honours an abort.
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(okResponse('page')), 3_000);
          init.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          });
        })
    );
    const url = 'https://developer.magiclane.com/shared.md';
    // A starts the download with 1 s left; B joins 100 ms later with 55 s left.
    const a = withRequestContext({ client: 'a', endBy: Date.now() + 1_000 }, () => fetchText(url)).catch(
      (e: unknown) => e
    );
    await vi.advanceTimersByTimeAsync(100);
    const b = withRequestContext({ client: 'b', endBy: Date.now() + 55_000 }, () => fetchText(url));
    await vi.advanceTimersByTimeAsync(1_000);
    const late = (await a) as Error;
    expect(late).toBeInstanceOf(FetchDeadlineError);
    expect(late.message).toBe(`No answer within the 1000 ms left to this request for ${url}`);
    expect(isLoadFailure(late)).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(b).resolves.toBe('page');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Alone, the late caller's download is aborted when it leaves — and not remembered: C fetches afresh.
    clearHttpCache();
    const other = 'https://developer.magiclane.com/alone.md';
    const alone = withRequestContext({ client: 'a', endBy: Date.now() + 1_000 }, () => fetchText(other)).catch(
      (e: unknown) => e
    );
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await alone).toBeInstanceOf(FetchDeadlineError);
    const c = withRequestContext({ client: 'c', endBy: Date.now() + 55_000 }, () => fetchText(other));
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(c).resolves.toBe('page');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not remember a timeout that the overall limit cut short of the host's own time", async () => {
    vi.useFakeTimers();
    const target = 'https://developer.magiclane.com/late-start.md';
    let targetAnswers = false;
    // Every slot is held for 15 s, so the target starts with 15 s of its 30 s left, and then hangs.
    fetchMock.mockImplementation((url: string, init: RequestInit) =>
      url === target && !targetAnswers
        ? hanging(url, init)
        : new Promise<Response>((resolve) => setTimeout(() => resolve(okResponse('held')), 15_000))
    );
    const holders = Array.from({ length: FETCH.maxConcurrent }, (_, i) =>
      fetchText(`https://developer.magiclane.com/hold-${i}.md`)
    );
    const late = fetchText(target).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(FETCH.overallTimeoutMs + 1);
    expect(((await late) as Error).message).toBe(
      `No answer within ${FETCH.overallTimeoutMs} ms of queueing for ${target}`
    );
    await Promise.all(holders);
    targetAnswers = true;
    fetchMock.mockImplementation(async () => okResponse('answered'));
    await expect(fetchText(target)).resolves.toBe('answered');
  });

  it("gives a batch's pages a slot wait that grows with the batch", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hanging);
    const stop = new AbortController();
    const holders = Array.from({ length: FETCH.maxConcurrent }, (_, i) =>
      conditionalFetch(`https://developer.magiclane.com/hold-${i}.md`, undefined, { signal: stop.signal }).catch(
        (e: unknown) => e
      )
    );
    const single = conditionalFetch('https://developer.magiclane.com/one.md', undefined, { client: 'x' }).catch(
      (e: unknown) => e
    );
    const batched = conditionalFetch('https://developer.magiclane.com/many.md', undefined, {
      client: 'x',
      batch: 20,
    }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs);
    expect(((await single) as Error).message).toBe(
      `No outbound slot within ${FETCH.timeoutMs} ms for https://developer.magiclane.com/one.md`
    );
    // The batch's page waited on: it got the slot the holders freed when they
    // timed out, and then ran into the site's own timeout instead.
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs);
    expect(((await batched) as Error).message).toBe(
      `No answer within ${FETCH.timeoutMs} ms for https://developer.magiclane.com/many.md`
    );
    stop.abort();
    await Promise.all(holders);
  });

  it("lets a batch's pages over HTTP wait and run until the call stops waiting, past the batch's own limit", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    // Every slot is held until 50.5 s (the holders' fetches ignore their aborts).
    fetchMock.mockImplementation((url: string) =>
      url.includes('/hold-')
        ? new Promise<Response>((resolve) => setTimeout(() => resolve(okResponse('held')), 50_500))
        : Promise.resolve(okResponse('in time'))
    );
    const holders = Array.from({ length: FETCH.maxConcurrent }, (_, i) =>
      fetchText(`https://developer.magiclane.com/hold-${i}.md`).catch((e: unknown) => e)
    );
    // A page of an HTTP call's large batch, the call waiting 55 s (its request budget)…
    const http = withRequestContext(
      { client: 'x', batch: 3 * FETCH.maxActivePerClient, endBy: start + FETCH.requestBudgetMs },
      () => fetchText('https://developer.magiclane.com/budget.md')
    );
    // …and one of a batch with no deadline of its own (stdio): it ends at the batch's 50 s.
    const stdio = withRequestContext({ batch: 20 }, () =>
      fetchText('https://developer.magiclane.com/no-budget.md')
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(FETCH.batchTimeoutMs);
    expect(((await stdio) as Error).message).toBe(
      `No outbound slot within ${FETCH.batchTimeoutMs} ms for https://developer.magiclane.com/no-budget.md`
    );
    await vi.advanceTimersByTimeAsync(500); // the slots free at 50.5 s, with 4.5 s of the call's time left
    await expect(http).resolves.toBe('in time');
    await Promise.all(holders);
  });

  it('lets one HTTP client hold only its share of the outbound queue', async () => {
    fetchMock.mockImplementation(hanging);
    const stop = new AbortController();
    const page = (i: number): string => `https://developer.magiclane.com/share-${i}.md`;
    const as = (client: string | undefined, i: number): Promise<unknown> =>
      withRequestContext({ client, signal: stop.signal }, () => fetchText(page(i))).catch((e: unknown) => e);
    const running = Array.from({ length: FETCH.maxConcurrent }, (_, i) => as(undefined, i));
    for (let i = 0; i < FETCH.maxQueuedPerClient; i++) running.push(as('a', FETCH.maxConcurrent + i));
    await Promise.resolve();
    expect(fetchQueueStats()).toMatchObject({ active: FETCH.maxConcurrent, queued: FETCH.maxQueuedPerClient });
    const refused = (await as('a', 999)) as Error;
    expect(refused).toBeInstanceOf(FetchBusyError);
    expect(refused.message).toContain('for this client');
    // Another client still gets a place in the queue; so does stdio (no client);
    // a queued index fetch (high priority) is not counted against anyone.
    running.push(
      as('b', 1000),
      as(undefined, 1001),
      conditionalFetch('https://developer.magiclane.com/docs/llms.txt', undefined, {
        priority: 'high',
        signal: stop.signal,
      }).catch((e: unknown) => e)
    );
    await Promise.resolve();
    expect(fetchQueueStats().queued).toBe(FETCH.maxQueuedPerClient + 3);
    running.push(as('b', 1002));
    await Promise.resolve();
    expect(fetchQueueStats().queued).toBe(FETCH.maxQueuedPerClient + 4); // queued, not refused
    stop.abort();
    for (const outcome of await Promise.all(running)) expect(outcome).toBeInstanceOf(RequestCancelledError);
    await vi.waitFor(() => expect(fetchQueueStats()).toMatchObject({ active: 0, queued: 0 }));
  });

  it('does not hand a new caller a download that earlier callers already abandoned', async () => {
    let calls = 0;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      calls += 1;
      if (calls === 1) return hanging(_url, init);
      return Promise.resolve(okResponse('fresh'));
    });
    const a = new AbortController();
    const first = withRequestContext({ signal: a.signal }, () => fetchText('https://developer.magiclane.com/late.md'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    a.abort();
    await expect(first).rejects.toBeInstanceOf(RequestCancelledError);
    // The abandoned entry is still being torn down when B arrives.
    await expect(fetchText('https://developer.magiclane.com/late.md')).resolves.toBe('fresh');
  });

  it('replaces an abandoned download that ignores its abort, and forgets the old one when it ends', async () => {
    let settle!: (r: Response) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (settle = resolve))) // deaf to abort
      .mockResolvedValueOnce(okResponse('fresh'));
    const a = new AbortController();
    const first = withRequestContext({ signal: a.signal }, () => fetchText('https://developer.magiclane.com/deaf.md'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    a.abort();
    await expect(first).rejects.toBeInstanceOf(RequestCancelledError);
    // The old download is still pending (aborted, but the mock never settles): B gets a new one.
    await expect(fetchText('https://developer.magiclane.com/deaf.md')).resolves.toBe('fresh');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    settle(okResponse('late'));
    await new Promise((r) => setImmediate(r));
    // The late result did not evict the fresh one from the in-flight table or the cache.
    expect(peekCached('https://developer.magiclane.com/deaf.md')).toBe('fresh');
  });

  it('retries a 5xx only after a quick attempt, and stops the retry sleep on cancellation', async () => {
    vi.useFakeTimers();
    // A host that answers 503 slowly: one attempt eats most of the deadline, so no retry.
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => setTimeout(() => resolve(errorResponse(503, 'Slow')), FETCH.timeoutMs * 0.6))
    );
    const slow = fetchText('https://developer.magiclane.com/slow503.md');
    const slowAssertion = expect(slow).rejects.toThrow('HTTP 503');
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs * 0.6 + 1);
    await slowAssertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A fast 503 is retried — unless the request is cancelled during the sleep.
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => errorResponse(503, 'Fast'));
    const controller = new AbortController();
    const cancelled = withRequestContext({ signal: controller.signal }, () =>
      fetchText('https://developer.magiclane.com/fast503.md')
    );
    const assertion = expect(cancelled).rejects.toBeInstanceOf(RequestCancelledError);
    await vi.advanceTimersByTimeAsync(FETCH.retryDelayMs / 2);
    controller.abort();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches an llms.txt index (the resource) free of the client budget and ahead of pages', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (url: string) => okResponse(url));
    const asA = (url: string): Promise<string> => withRequestContext({ client: 'a' }, () => fetchText(url));
    for (let i = 0; i < FETCH.perClientMaxFetches; i++) await asA(`https://developer.magiclane.com/f-${i}.md`);
    await expect(asA('https://developer.magiclane.com/f-x.md')).rejects.toBeInstanceOf(FetchBudgetError);
    await expect(asA('https://developer.magiclane.com/docs/flutter/llms.txt')).resolves.toContain('llms.txt');
  });

  it('runs at most FETCH.maxConcurrent requests at once', async () => {
    vi.useFakeTimers();
    let active = 0;
    let peak = 0;
    fetchMock.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return okResponse('x');
    });
    const all = Promise.all(
      Array.from({ length: FETCH.maxConcurrent * 3 }, (_, i) =>
        fetchText(`https://developer.magiclane.com/par-${i}.md`)
      )
    );
    // Three rounds of FETCH.maxConcurrent, each answering after 5 ms.
    for (let round = 0; round < 3; round++) await vi.advanceTimersByTimeAsync(5);
    await all;
    expect(peak).toBe(FETCH.maxConcurrent);
  });
});
