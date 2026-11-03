/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callsInFlight, callsSettled, callsSettledOrStalled, trackCall } from '../../src/utils/calls-in-flight.js';

/** A promise settled from outside. */
function held<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Nothing to wait for, ever: the grace counts from the wait's start. */
const neverBusy = (): number => Number.NEGATIVE_INFINITY;

describe('calls in flight', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts a tracked call until the turn after it settles, resolved or rejected', async () => {
    await callsSettled();
    expect(callsInFlight()).toBe(0);
    const a = held<string>();
    const b = held<string>();
    expect(trackCall(a.promise)).toBe(a.promise);
    trackCall(b.promise).catch(() => {});
    expect(callsInFlight()).toBe(2);
    a.resolve('done');
    await a.promise;
    expect(callsInFlight()).toBe(2); // the SDK writes the result in the microtasks after it settles
    await tick();
    expect(callsInFlight()).toBe(1);
    b.reject(new Error('failed'));
    await tick();
    await tick();
    expect(callsInFlight()).toBe(0);
  });

  it('settles once the last call, and any started meanwhile, has answered', async () => {
    let settled = false;
    await expect(callsSettled()).resolves.toBeUndefined(); // nothing to wait for
    const first = held<void>();
    trackCall(first.promise);
    const waiting = callsSettled().then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    const second = held<void>();
    trackCall(second.promise); // started while the wait is on: waited for too
    first.resolve();
    await tick();
    await tick();
    expect(settled).toBe(false);
    expect(callsInFlight()).toBe(1);
    second.resolve();
    await waiting;
    expect(settled).toBe(true);
    expect(callsInFlight()).toBe(0);
  });

  it('is settled when the running calls answer within the grace', async () => {
    const call = held<void>();
    trackCall(call.promise);
    const outcome = callsSettledOrStalled(1_000, neverBusy);
    await sleep(20);
    call.resolve();
    await expect(outcome).resolves.toBe('settled');
  });

  it('is settled at once with nothing running', async () => {
    await expect(callsSettledOrStalled(1_000, neverBusy)).resolves.toBe('settled');
  });

  it("is stalled a grace after the wait's start when there is nothing to wait for", async () => {
    vi.useFakeTimers();
    const call = held<void>();
    trackCall(call.promise);
    let outcome: string | undefined;
    void callsSettledOrStalled(3_000, neverBusy).then((o) => (outcome = o));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(outcome).toBeUndefined(); // not at once, though the last activity is long past
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('stalled');
    expect(callsInFlight()).toBe(1); // still running: the caller closes the server, which aborts it
    call.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(callsInFlight()).toBe(0);
  });

  it('keeps waiting however long there is something to wait for, then stalls exactly a grace after it ends', async () => {
    vi.useFakeTimers();
    const call = held<void>();
    trackCall(call.promise);
    // A request within its own limit whose first byte takes 19 s, and nothing after it.
    const busyUntil = Date.now() + 19_000;
    let outcome: string | undefined;
    void callsSettledOrStalled(3_000, () => Math.min(Date.now(), busyUntil)).then((o) => (outcome = o));
    await vi.advanceTimersByTimeAsync(21_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('stalled');
    call.resolve();
    await vi.advanceTimersByTimeAsync(1);
  });

  it('counts the grace from the last thing that came: a site that keeps sending keeps the calls running', async () => {
    vi.useFakeTimers();
    const call = held<void>();
    trackCall(call.promise);
    let lastByte = Date.now();
    const feed = setInterval(() => (lastByte = Date.now()), 2_500); // the site keeps sending, slowly
    let outcome: string | undefined;
    void callsSettledOrStalled(3_000, () => lastByte).then((o) => (outcome = o));
    await vi.advanceTimersByTimeAsync(10_000);
    clearInterval(feed); // then goes quiet: its last chunk came at 10 s
    await vi.advanceTimersByTimeAsync(2_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('stalled');
    call.resolve();
    await vi.advanceTimersByTimeAsync(1);
  });
});
