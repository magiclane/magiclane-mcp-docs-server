/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The per-source memo under failure: an outage is remembered so calls answer
 * at once, a slow refresh does not hold up a stale answer, and a cancelled
 * request stops waiting without cancelling the shared download.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceMemo } from '../../src/docs/source-memo.js';
import { CACHE, FETCH } from '../../src/config/constants.js';
import {
  clearHttpCache,
  conditionalFetch,
  FetchPriorityControl,
  fetchQueueStats,
  fetchText,
} from '../../src/utils/http-client.js';
import { RequestCancelledError, withRequestContext } from '../../src/utils/request-context.js';

const URL_A = 'https://developer.magiclane.com/docs/flutter/llms.txt';

const ok = (body: string): Response => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });

describe('SourceMemo', () => {
  const fetchMock = vi.fn();
  let memo: SourceMemo<string>;

  beforeEach(() => {
    clearHttpCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    memo = new SourceMemo((body) => body.toUpperCase());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps the downloaded text only when asked to, served from the same single download', async () => {
    fetchMock.mockImplementation(async () => ok('index text'));
    const kept = new SourceMemo((body) => body.length, { keepText: true });
    await expect(kept.loadText('flutter', URL_A)).resolves.toBe('index text');
    await expect(kept.load('flutter', URL_A)).resolves.toBe(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    kept.seed('ios', 'seeded');
    await expect(kept.loadText('ios', URL_A)).resolves.toBe('seeded');
    await expect(memo.loadText('flutter', URL_A)).resolves.toBe('');
  });

  it('loads at background priority when no call waits for it (a health probe), leaving a slot free', async () => {
    const hold = Array.from({ length: FETCH.maxConcurrent - 1 }, () => new AbortController());
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          if (String(_url).endsWith('llms.txt')) resolve(ok('index'));
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );
    const busy = hold.map((c, i) =>
      withRequestContext({ signal: c.signal }, () => fetchText(`https://developer.magiclane.com/busy-${i}.md`)).catch(
        () => {}
      )
    );
    await vi.waitFor(() => expect(fetchQueueStats().active).toBe(FETCH.maxConcurrent - 1));
    // The last free slot is not a background reload's: it waits.
    const background = withRequestContext({ background: true }, () => memo.load('flutter', URL_A));
    await Promise.resolve();
    expect(fetchQueueStats().queued).toBe(1);
    // A call's own load takes it at once.
    await expect(memo.load('android', 'https://developer.magiclane.com/docs/android/llms.txt')).resolves.toBe('INDEX');
    hold[0]!.abort();
    await expect(background).resolves.toBe('INDEX');
    for (const c of hold) c.abort();
    await Promise.all(busy);
  });

  it("raises a probe's reload to a call's priority when the call needs the same file", async () => {
    // Every slot is busy with page fetches that hang, and another page waits.
    const holders = Array.from({ length: FETCH.maxConcurrent }, () => new AbortController());
    const started: string[] = [];
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      started.push(url);
      return new Promise<Response>((resolve, reject) => {
        if (url.endsWith('llms.txt')) resolve(ok('index'));
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    });
    const busy = holders.map((c, i) =>
      withRequestContext({ signal: c.signal }, () => fetchText(`https://developer.magiclane.com/busy-${i}.md`)).catch(
        () => {}
      )
    );
    await vi.waitFor(() => expect(started).toHaveLength(FETCH.maxConcurrent));
    const stop = new AbortController();
    const page = withRequestContext({ signal: stop.signal }, () =>
      fetchText('https://developer.magiclane.com/waiting.md')
    ).catch(() => {});
    // The probe's reload queues behind that page.
    const background = withRequestContext({ background: true }, () => memo.load('flutter', URL_A));
    await Promise.resolve();
    expect(fetchQueueStats().queued).toBe(2);
    // A call joins it: the reload now goes ahead of the page, and takes the next free slot.
    const call = memo.load('flutter', URL_A);
    holders[0]!.abort();
    await expect(call).resolves.toBe('INDEX');
    await expect(background).resolves.toBe('INDEX');
    expect(started[FETCH.maxConcurrent]).toBe(URL_A); // before the page that waited longer
    stop.abort();
    for (const c of holders) c.abort();
    await Promise.all([...busy, page]);
  });

  it('lets a call join a reload that is already running, and a waiting reload leave the queue when abandoned', async () => {
    let answer: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));
    // Slots free: the probe's reload starts at once; a call joining it has nothing to raise.
    const background = withRequestContext({ background: true }, () => memo.load('flutter', URL_A));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const call = memo.load('flutter', URL_A);
    answer(ok('index'));
    await expect(Promise.all([background, call])).resolves.toEqual(['INDEX', 'INDEX']);
    // A controlled fetch abandoned while it waits leaves the queue.
    const holders = Array.from({ length: FETCH.maxConcurrent }, () => new AbortController());
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        )
    );
    const busy = holders.map((c, i) =>
      withRequestContext({ signal: c.signal }, () => fetchText(`https://developer.magiclane.com/held-${i}.md`)).catch(
        () => {}
      )
    );
    await vi.waitFor(() => expect(fetchQueueStats().active).toBe(FETCH.maxConcurrent));
    const stop = new AbortController();
    const control = new FetchPriorityControl('background');
    const waiting = conditionalFetch(URL_A, undefined, { control, signal: stop.signal }).catch((e: unknown) => e);
    await Promise.resolve();
    expect(control.waiter).toBeDefined();
    stop.abort();
    await waiting;
    expect(control.waiter).toBeUndefined();
    expect(fetchQueueStats().queued).toBe(0);
    for (const c of holders) c.abort();
    await Promise.all(busy);
  });

  it('remembers a failed load for a while, so an outage answers at once', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(new Response('', { status: 404, statusText: 'Not Found' }));
    await expect(memo.load('flutter', URL_A)).rejects.toThrow('HTTP 404');
    await expect(memo.load('flutter', URL_A)).rejects.toThrow('HTTP 404');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(FETCH.failureMemoMs + 1);
    fetchMock.mockResolvedValue(ok('index'));
    await expect(memo.load('flutter', URL_A)).resolves.toBe('INDEX');
  });

  it('does not remember a load that never got an outbound slot: the site was never asked', async () => {
    vi.useFakeTimers();
    // Every slot is held by a page that hangs and ignores its abort; the index waits for a slot.
    const holders: Array<() => void> = [];
    fetchMock.mockImplementation((url: string) =>
      String(url).endsWith('llms.txt')
        ? Promise.resolve(ok('index'))
        : new Promise<Response>((resolve) => holders.push(() => resolve(ok('late'))))
    );
    const busy = Array.from({ length: FETCH.maxConcurrent }, (_, i) =>
      fetchText(`https://developer.magiclane.com/hold-${i}.md`).catch(() => {})
    );
    const load = withRequestContext({ background: true }, () => memo.load('flutter', URL_A)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(FETCH.overallTimeoutMs + FETCH.timeoutMs + 1);
    expect(String(await load)).toMatch(/No outbound slot within/);
    // Never sent: no start to report, and not a file the site hung for.
    expect(memo.failing()).toEqual([
      { source: 'flutter', reason: expect.stringContaining('No outbound slot'), serving: 'nothing' },
    ]);
    for (const release of holders) release();
    await Promise.all(busy);
    // Not remembered as the site's failure: the next load asks the site at once.
    await expect(memo.load('flutter', URL_A)).resolves.toBe('INDEX');
  });

  it("marks a file whose download was sent and got no answer as hung, for the order of the probes' reloads", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );
    const load = memo.load('flutter', URL_A).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(FETCH.timeoutMs + 1);
    expect(String(await load)).toMatch(/No answer within/);
    expect(memo.failing()).toEqual([
      {
        source: 'flutter',
        reason: expect.stringContaining('No answer within'),
        serving: 'nothing',
        startedAt: expect.any(Number),
        hung: true,
      },
    ]);
    // The next load fails fast (a 5xx, retried once): a failure, but not a hang.
    vi.advanceTimersByTime(FETCH.failureMemoMs + 1);
    fetchMock.mockResolvedValue(new Response('', { status: 503, statusText: 'Unavailable' }));
    const failed = memo.load('flutter', URL_A).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(FETCH.retryDelayMs + 1);
    expect(String(await failed)).toMatch(/HTTP 503/);
    expect(memo.failing()).toHaveLength(1);
    expect(memo.failing()[0]).not.toHaveProperty('hung');
  });

  it('reports remembered failures, and whether a stale copy is served meanwhile', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(ok('old'));
    await memo.load('flutter', URL_A);
    vi.advanceTimersByTime(CACHE.ttlMs + 1);
    fetchMock.mockResolvedValue(new Response('', { status: 404, statusText: 'Not Found' }));
    await memo.load('flutter', URL_A);
    await expect(memo.load('ios', URL_A)).rejects.toThrow('HTTP 404');
    expect(memo.failing()).toEqual([
      { source: 'flutter', reason: expect.stringContaining('HTTP 404'), serving: 'stale copy', startedAt: Date.now() },
      { source: 'ios', reason: expect.stringContaining('HTTP 404'), serving: 'nothing', startedAt: Date.now() },
    ]);
    // Still failing after the memo expires: until a load succeeds.
    vi.advanceTimersByTime(FETCH.failureMemoMs + 1);
    expect(memo.failing().map((f) => f.source)).toEqual(['flutter', 'ios']);
    fetchMock.mockResolvedValue(ok('new'));
    await memo.load('flutter', URL_A);
    expect(memo.failing().map((f) => f.source)).toEqual(['ios']);
    expect(memo.loadedCount()).toBe(1);
  });

  it('counts a downloaded file that does not parse as a failed load, serving the previous copy meanwhile', async () => {
    vi.useFakeTimers();
    const strict = new SourceMemo<string>((body) => {
      if (body === '') throw new Error('the file holds no pages');
      return body;
    });
    // Nothing loaded yet: the bad file is a failure, remembered like an outage.
    fetchMock.mockResolvedValue(ok(''));
    await expect(strict.load('flutter', URL_A)).rejects.toThrow('the file holds no pages');
    await expect(strict.load('flutter', URL_A)).rejects.toThrow('the file holds no pages');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(strict.failing()).toEqual([
      { source: 'flutter', reason: 'the file holds no pages', serving: 'nothing', startedAt: Date.now() },
    ]);
    expect(strict.loadedCount()).toBe(0);
    // A good file clears it.
    vi.advanceTimersByTime(FETCH.failureMemoMs + 1);
    fetchMock.mockResolvedValue(ok('index'));
    await expect(strict.load('flutter', URL_A)).resolves.toBe('index');
    expect(strict.failing()).toEqual([]);
    // A bad file on refresh: the previous copy is served, and the failure reported.
    vi.advanceTimersByTime(CACHE.ttlMs + 1);
    fetchMock.mockResolvedValue(ok(''));
    await expect(strict.load('flutter', URL_A)).resolves.toBe('index');
    expect(strict.failing()).toEqual([
      { source: 'flutter', reason: 'the file holds no pages', serving: 'stale copy', startedAt: Date.now() },
    ]);
    // Seeding a bad file installs the failure, not a value; seeding a good one clears it.
    strict.seed('ios', '');
    expect(strict.loadedCount()).toBe(1);
    expect(strict.failing().map((f) => f.source)).toEqual(['flutter', 'ios']);
    await expect(strict.load('ios', URL_A)).rejects.toThrow('the file holds no pages');
    strict.seed('ios', 'pages');
    expect(strict.failing().map((f) => f.source)).toEqual(['flutter']);
    await expect(strict.load('ios', URL_A)).resolves.toBe('pages');
  });

  it('reports a download that hangs, before it times out', async () => {
    vi.useFakeTimers();
    let release!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));
    const pending = memo.load('flutter', URL_A);
    expect(memo.failing()).toEqual([]);
    vi.advanceTimersByTime(FETCH.staleGraceMs + 1000);
    expect(memo.failing()).toEqual([{ source: 'flutter', reason: 'no answer for 6 s', serving: 'nothing' }]);
    release(ok('late'));
    await expect(pending).resolves.toBe('LATE');
    expect(memo.failing()).toEqual([]);
  });

  it('reports a failure that is not an Error by its text', async () => {
    fetchMock.mockRejectedValue('socket hang up');
    await expect(memo.load('flutter', URL_A)).rejects.toBeDefined();
    expect(memo.failing()).toEqual([expect.objectContaining({ source: 'flutter', serving: 'nothing' })]);
  });

  it('serves the stale value during a remembered outage', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(ok('old'));
    await memo.load('flutter', URL_A);
    vi.advanceTimersByTime(CACHE.ttlMs + 1);
    fetchMock.mockResolvedValue(new Response('', { status: 404, statusText: 'Not Found' }));
    await expect(memo.load('flutter', URL_A)).resolves.toBe('OLD');
    await expect(memo.load('flutter', URL_A)).resolves.toBe('OLD');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('answers from the stale value when a refresh is slow, and keeps the refreshed one', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(ok('old'));
    await memo.load('flutter', URL_A);
    vi.advanceTimersByTime(CACHE.ttlMs + 1);
    let release!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));
    const pending = memo.load('flutter', URL_A);
    await vi.advanceTimersByTimeAsync(FETCH.staleGraceMs + 1);
    await expect(pending).resolves.toBe('OLD');
    release(ok('new'));
    await vi.waitFor(() => expect(memo.loaded().get('flutter')).toBe('NEW'));
  });

  it('stops waiting for a cancelled request but finishes the shared download', async () => {
    let release!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));
    const controller = new AbortController();
    const cancelled = withRequestContext({ signal: controller.signal }, () => memo.load('flutter', URL_A));
    const other = memo.load('flutter', URL_A);
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(RequestCancelledError);
    release(ok('shared'));
    await expect(other).resolves.toBe('SHARED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
