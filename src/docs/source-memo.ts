/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Per-source memo for the two documentation files this server parses (the
 * llms.txt index and the llms-full.txt page export). It is separate from the
 * page cache in utils/http-client.ts on purpose: user-chosen page URLs can
 * never evict an index, and a multi-megabyte full-text body is parsed once and
 * then dropped — only the parsed value and the upstream validators are kept.
 *
 * Behaviour under failure is what the tools rely on: concurrent loads of one
 * source share a single download; when a refresh fails the previous value is
 * served (stale) rather than reporting "nothing found"; a failed refresh is
 * remembered for `FETCH.failureMemoMs`, so during an outage calls answer at
 * once instead of each waiting for its own timeout; and a slow refresh is
 * waited for at most `FETCH.staleGraceMs` when a stale value can be served.
 */
import { CACHE, FETCH } from '../config/constants.js';
import {
  conditionalFetch,
  failureMemoFor,
  FetchPriorityControl,
  isSiteFailure,
  isTimeout,
  isTransientFailure,
} from '../utils/http-client.js';
import { errorMessage } from '../utils/errors.js';
import type { CacheValidators } from '../utils/http-client.js';
import { stillAhead, withinLast } from '../utils/clock.js';
import { currentRequest, RequestCancelledError, unlessCancelled } from '../utils/request-context.js';

interface MemoEntry<T> extends CacheValidators {
  value: T;
  at: number;
  /** The file as downloaded, when the memo keeps it (see the keepText option). */
  text?: string;
}

/** A source file that could not be loaded, with the upstream reason. */
export interface SourceFailure {
  source: string;
  /** Which file failed: the llms.txt index or the llms-full.txt page contents. */
  part: 'index' | 'full-text';
  reason: string;
  /**
   * "unreachable": developer.magiclane.com did not answer in time or failed
   * (5xx, network) — a retry may help. "file": it answered, but with no usable
   * file (404, an HTML page, an empty or malformed file) — a retry will not.
   */
  kind: 'unreachable' | 'file';
}

/** A failed load of one source file, classified for the wording tools use. */
export function sourceFailure(source: string, part: SourceFailure['part'], err: unknown): SourceFailure {
  const unreachable = isTransientFailure(err) || err instanceof RequestCancelledError;
  return { source, part, reason: errorMessage(err), kind: unreachable ? 'unreachable' : 'file' };
}

/** A file that failed to load, or hangs, as /health reports it. */
export interface FailingFile {
  source: string;
  reason: string;
  /** What calls get meanwhile: the previous copy, or nothing from that file. */
  serving: 'stale copy' | 'nothing';
  /** When a download of it last got going (ms since epoch); absent when none has. */
  startedAt?: number;
  /**
   * The last download of it was sent and got no answer in time (the site
   * hung for this file): the probes reload such files after the others, so
   * one that keeps hanging does not hold the background slots while files
   * that failed fast wait.
   */
  hung?: true;
}

export class SourceMemo<T> {
  private readonly entries = new Map<string, MemoEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly failures = new Map<string, { until: number; error: unknown }>();
  /** The last failed load of each source, kept until a load succeeds (what /health reports), and whether it hung. */
  private readonly lastError = new Map<string, { error: unknown; hung: boolean }>();
  /** When each download in flight started, so one that hangs shows before it times out. */
  private readonly started = new Map<string, number>();
  /** When a download of each source last got going (its request sent), for the order of the probes' reloads. */
  private readonly lastStarted = new Map<string, number>();
  /** The priority of each download in flight, so a call that joins a background reload can raise it. */
  private readonly priorities = new Map<string, FetchPriorityControl>();

  /** Whether the file's text is kept beside its parsed value (the small index files, served as MCP resources). */
  private readonly keepText: boolean;

  constructor(
    private readonly parse: (body: string, sourceId: string) => T,
    options: { keepText?: boolean } = {}
  ) {
    this.keepText = options.keepText ?? false;
  }

  /**
   * The file's text as last downloaded, loaded as `load` does — one download
   * shared with the tools, the same memo, stale copy and failure rules. Empty
   * for a memo that does not keep text.
   */
  async loadText(sourceId: string, url: string): Promise<string> {
    await this.load(sourceId, url);
    return this.entries.get(sourceId)?.text ?? '';
  }

  /**
   * The parsed value for one source, downloading or revalidating when the
   * memo is older than the cache TTL. Throws only when nothing can be served.
   * A cancelled request stops waiting; the shared download carries on for
   * the others (and for the memo).
   */
  async load(sourceId: string, url: string): Promise<T> {
    const now = Date.now();
    const cached = this.entries.get(sourceId);
    if (cached && withinLast(cached.at, CACHE.ttlMs, now)) return cached.value;

    const failure = this.failures.get(sourceId);
    if (failure && stillAhead(failure.until, FETCH.failureMemoMs, now)) {
      if (cached) return cached.value;
      throw failure.error;
    }

    let pending = this.inFlight.get(sourceId);
    // A call that needs a file a health probe is reloading raises the reload
    // to the priority of its own fetches, instead of waiting behind them.
    if (pending && !currentRequest()?.background) this.priorities.get(sourceId)?.raise();
    if (!pending) {
      this.started.set(sourceId, now);
      pending = this.refresh(sourceId, url, cached).finally(() => {
        this.inFlight.delete(sourceId);
        this.started.delete(sourceId);
        this.priorities.delete(sourceId);
      });
      pending.catch(() => {}); // the outcome reaches every caller below
      this.inFlight.set(sourceId, pending);
    }
    const signal = currentRequest()?.signal;
    if (!cached) return unlessCancelled(pending, signal);

    let timer: NodeJS.Timeout | undefined;
    const stale = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(cached.value), FETCH.staleGraceMs);
    });
    try {
      return await unlessCancelled(Promise.race([pending, stale]), signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private async refresh(sourceId: string, url: string, cached: MemoEntry<T> | undefined): Promise<T> {
    let result;
    let started = false;
    try {
      // A reload no call is waiting for (a health probe's) queues behind the
      // calls' fetches — until a call joins it (see load).
      const control = new FetchPriorityControl(currentRequest()?.background ? 'background' : 'high');
      this.priorities.set(sourceId, control);
      result = await conditionalFetch(url, cached, {
        control,
        onStart: () => {
          started = true;
          this.lastStarted.set(sourceId, Date.now());
        },
      });
    } catch (err) {
      // Remembered for 30 s only when the site failed (see isSiteFailure): a
      // load that never got a slot, or was cut short, is tried again at once.
      if (isSiteFailure(err, started)) {
        this.failures.set(sourceId, { until: Date.now() + failureMemoFor(err), error: err });
      } else this.failures.delete(sourceId);
      // Hung: the request was sent and the site never answered it in time.
      this.lastError.set(sourceId, { error: err, hung: started && isTimeout(err) });
      // Upstream is unreachable: an hour-old index beats an empty answer.
      if (cached) return cached.value;
      throw err;
    }
    this.failures.delete(sourceId);
    this.lastError.delete(sourceId);
    if (result.status === 'unchanged') {
      // `cached` is guaranteed here: a 304 is only accepted when validators were sent.
      const entry = cached as MemoEntry<T>;
      entry.at = Date.now();
      return entry.value;
    }
    let value: T;
    try {
      value = this.parse(result.body, sourceId);
    } catch (err) {
      // Downloaded, but not a usable file (empty, or not the expected
      // format): a failure like any other, so /health reports it and the
      // previous copy, when there is one, is served meanwhile.
      this.failures.set(sourceId, { until: Date.now() + FETCH.failureMemoMs, error: err });
      this.lastError.set(sourceId, { error: err, hung: false });
      if (cached) return cached.value;
      throw err;
    }
    this.failures.delete(sourceId);
    this.lastError.delete(sourceId);
    this.entries.set(sourceId, {
      value,
      at: Date.now(),
      ...result.validators,
      ...(this.keepText ? { text: result.body } : {}),
    });
    return value;
  }

  /**
   * Install a value directly (tests, pre-warming), bypassing the network. A
   * body that does not parse is installed as a failed load, as a download of
   * it would be.
   */
  seed(sourceId: string, body: string): void {
    try {
      const value = this.parse(body, sourceId);
      this.entries.set(sourceId, { value, at: Date.now(), ...(this.keepText ? { text: body } : {}) });
    } catch (err) {
      this.entries.delete(sourceId);
      this.failures.set(sourceId, { until: Date.now() + FETCH.failureMemoMs, error: err });
      this.lastError.set(sourceId, { error: err, hung: false });
      return;
    }
    this.failures.delete(sourceId);
    this.lastError.delete(sourceId);
  }

  /**
   * Sources in trouble, with the reason and whether an older copy is still
   * being served — what /health reports as trouble upstream: a source whose
   * last load failed (until a load succeeds, however long ago it failed), and
   * one whose download has been hanging for longer than `FETCH.staleGraceMs`.
   */
  failing(now: number = Date.now()): FailingFile[] {
    const out: FailingFile[] = [];
    const file = (source: string, reason: string, hung = false): FailingFile => ({
      source,
      reason,
      serving: this.entries.has(source) ? 'stale copy' : 'nothing',
      ...(this.lastStarted.has(source) ? { startedAt: this.lastStarted.get(source) as number } : {}),
      ...(hung ? { hung: true } : {}),
    });
    for (const [source, { error, hung }] of this.lastError) {
      out.push(file(source, error instanceof Error ? error.message : String(error), hung));
    }
    for (const [source, since] of this.started) {
      if (this.lastError.has(source) || now - since <= FETCH.staleGraceMs) continue;
      out.push(file(source, `no answer for ${Math.round((now - since) / 1000)} s`));
    }
    return out;
  }

  /** The value in memory for one source, fresh or stale, without waiting for a download; undefined before the first load. */
  peek(sourceId: string): T | undefined {
    return this.entries.get(sourceId)?.value;
  }

  /** How many sources have a value (fresh or stale) to serve. */
  loadedCount(): number {
    return this.entries.size;
  }

  /** Memoized sources, for diagnostics. */
  loaded(): Map<string, T> {
    return new Map([...this.entries].map(([id, entry]) => [id, entry.value]));
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.failures.clear();
    this.lastError.clear();
    this.started.clear();
  }
}
