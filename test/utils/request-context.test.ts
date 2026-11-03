/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  currentRequest,
  RequestCancelledError,
  unlessCancelled,
  withRequestContext,
} from '../../src/utils/request-context.js';

describe('request context', () => {
  it('is absent outside a request and merged over the enclosing one inside', async () => {
    expect(currentRequest()).toBeUndefined();
    const signal = new AbortController().signal;
    await withRequestContext({ client: 'a' }, () =>
      withRequestContext({ signal }, async () => {
        await Promise.resolve();
        expect(currentRequest()).toEqual({ client: 'a', signal });
      })
    );
  });
});

describe('unlessCancelled', () => {
  it('passes the promise through without a signal, and its outcome while the signal is quiet', async () => {
    await expect(unlessCancelled(Promise.resolve(1), undefined)).resolves.toBe(1);
    const signal = new AbortController().signal;
    await expect(unlessCancelled(Promise.resolve(2), signal)).resolves.toBe(2);
    await expect(unlessCancelled(Promise.reject(new Error('no')), signal)).rejects.toThrow('no');
  });

  it('rejects at once for an aborted signal, and as soon as the signal aborts', async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(unlessCancelled(Promise.reject(new Error('ignored')), aborted.signal)).rejects.toBeInstanceOf(
      RequestCancelledError
    );
    const later = new AbortController();
    const pending = unlessCancelled(new Promise(() => {}), later.signal);
    later.abort();
    await expect(pending).rejects.toThrow('Request cancelled by the client');
  });
});
