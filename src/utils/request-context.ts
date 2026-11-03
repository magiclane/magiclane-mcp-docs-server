/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What the outbound fetch pipeline needs to know about the MCP request it is
 * working for, carried implicitly (AsyncLocalStorage) so the docs layer does
 * not thread it through every function:
 *
 * - `signal` aborts when the request is cancelled: over HTTP when the client
 *   disconnects (each POST is its own server, so a `notifications/cancelled`
 *   sent as a separate POST reaches nothing); over stdio when the client sends
 *   `notifications/cancelled`. Work queued for the request is dropped instead
 *   of finishing for nobody.
 * - `client` names the HTTP client (its rate-limit key), so each client gets
 *   its own outbound-fetch budget. It is absent on stdio, where the single
 *   client is the user's own process.
 * - `track` lets the HTTP app keep a request's concurrency slot until the tool
 *   work started for it has really finished, not merely until the response
 *   socket closed.
 * - `batch` is how many pages the call fetches together (read_docs_batch): its
 *   pages queue for slots at once, so they may wait longer (see
 *   FETCH.batchTimeoutMs).
 * - `background` marks work no call is waiting for (a health probe's reload):
 *   its fetches go after the calls' (see FetchPriority).
 * - `endBy` is when the call stops waiting for its page fetches (ms since
 *   epoch): the HTTP request's budget (see FETCH.requestBudgetMs). It ends
 *   this call's wait only — a download shared with other calls goes on —
 *   and a batch's pages may wait and run until it (see FETCH.batchTimeoutMs).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  signal?: AbortSignal;
  client?: string;
  track?: (work: Promise<unknown>) => void;
  batch?: number;
  background?: boolean;
  endBy?: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `context` merged over the enclosing request context. */
export function withRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, fn);
}

/** The context of the request currently being served, if any. */
export function currentRequest(): RequestContext | undefined {
  return storage.getStore();
}

/** The error a cancelled request's pending work rejects with. */
export class RequestCancelledError extends Error {
  constructor() {
    super('Request cancelled by the client');
    this.name = 'RequestCancelledError';
  }
}

/**
 * Settle with `promise`, or reject with RequestCancelledError as soon as
 * `signal` aborts. The promise itself is not cancelled — shared work (a
 * download other requests also wait for) keeps running for them.
 */
export function unlessCancelled<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(new RequestCancelledError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new RequestCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}
