/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The MCP calls running now — tool calls and resource reads, in any
 * transport — for the stdio entry's end: when the client closes stdin, the
 * calls it is still waiting for finish and their results go out first. A call
 * is counted until its result has been written: the SDK writes it in the
 * microtasks after the call's promise settles, so the entry goes on the next
 * turn of the event loop.
 */

const calls = new Set<Promise<unknown>>();

/** Count `work` (a tool call or a resource read) as running until its result has been written. Returns `work`. */
export function trackCall<T>(work: Promise<T>): Promise<T> {
  calls.add(work);
  const done = (): NodeJS.Immediate => setImmediate(() => calls.delete(work));
  work.then(done, done);
  return work;
}

/** How many calls are running now. */
export function callsInFlight(): number {
  return calls.size;
}

/**
 * Resolves once no call is running: the ones running now have finished, and
 * so have any started meanwhile. A failed call is an answer (an isError
 * result), not a rejection; a resource read that rejects is answered too.
 */
export async function callsSettled(): Promise<void> {
  while (calls.size > 0) {
    await Promise.allSettled([...calls]);
    await new Promise((resolve) => setImmediate(resolve)); // the entries of the settled calls go
  }
}

/**
 * Resolves `settled` once no call is running, or `stalled` once the running
 * calls have had nothing to wait for during `graceMs`. `idleSince()` says
 * since when (ms since epoch; the present while they wait for something) —
 * for the stdio entry, upstreamIdleSince in http-client.ts: a fetch the site
 * may yet answer within its own limits keeps the calls running however long
 * its first byte takes, and so does a site that keeps sending. Counted from
 * this wait's start at the earliest, and checked when the grace would run
 * out, so the calls get exactly `graceMs`.
 */
export function callsSettledOrStalled(graceMs: number, idleSince: () => number): Promise<'settled' | 'stalled'> {
  const started = Date.now();
  return new Promise((resolve) => {
    const check = (): void => {
      const idle = Date.now() - Math.max(started, idleSince());
      if (idle >= graceMs) {
        resolve('stalled');
        return;
      }
      timer = setTimeout(check, graceMs - idle);
    };
    let timer = setTimeout(check, graceMs);
    void callsSettled().then(() => {
      clearTimeout(timer);
      resolve('settled');
    });
  });
}
