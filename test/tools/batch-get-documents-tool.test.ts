/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE, connectClient, isError, seedFixtures, seedPage, stubFetch, textOf } from '../helpers.js';
import type { TestClient } from '../helpers.js';
import { FETCH, LIMITS } from '../../src/config/constants.js';

describe('read_docs_batch', () => {
  let t: TestClient;
  let restore = (): void => {};

  beforeEach(async () => {
    seedFixtures();
    t = await connectClient();
  });

  afterEach(async () => {
    restore();
    restore = () => {};
    await t.close();
  });

  it('fetches multiple pages and numbers them', async () => {
    seedPage('/docs/guides/map-studio.md', '# Map Studio');
    const result = await t.client.callTool({
      name: 'read_docs_batch',
      arguments: { urls: ['/docs/guides/get-started', '/docs/guides/map-studio'] },
    });
    const text = textOf(result);
    expect(text).toContain('# Document 1: https://developer.magiclane.com/docs/guides/get-started');
    expect(text).toContain('# Document 2: https://developer.magiclane.com/docs/guides/map-studio');
    expect(text).toContain('# Map Studio');
    expect(isError(result)).toBe(false);
  });

  it('reports failed pages individually without failing the batch', async () => {
    ({ restore } = stubFetch({}));
    const result = await t.client.callTool({
      name: 'read_docs_batch',
      arguments: { urls: ['/docs/guides/get-started', '/docs/guides/missing', 'https://evil.example/x'] },
    });
    const text = textOf(result);
    expect(isError(result)).toBe(false);
    expect(text).toContain('# Document 2: /docs/guides/missing\n\nERROR: failed to fetch (HTTP 404');
    expect(text).toContain(
      '# Document 3: https://evil.example/x\n\nERROR: failed to fetch (Only https://developer.magiclane.com'
    );
  });

  it('keeps the header of a page that failed on one line, and no longer than the error quotes', async () => {
    ({ restore } = stubFetch({}));
    const broken = '/docs/guides/\nmissing\r\n  page';
    const long = `/docs/guides/${'x'.repeat(300)}`;
    const text = textOf(await t.client.callTool({ name: 'read_docs_batch', arguments: { urls: [broken, long] } }));
    expect(text).toContain('# Document 1: /docs/guides/ missing page\n\nERROR: failed to fetch (HTTP 404');
    expect(text).toContain(`# Document 2: ${long.slice(0, 120)}…\n\nERROR: failed to fetch (HTTP 404`);
    expect(text).not.toContain(`# Document 2: ${long.slice(0, 121)}`);
    // An emoji across the cut is dropped whole, never halved into a lone surrogate.
    const emoji = `/docs/${'x'.repeat(113)}😀${'y'.repeat(10)}`;
    const cut = textOf(await t.client.callTool({ name: 'read_docs_batch', arguments: { urls: [emoji, emoji] } }));
    expect(cut).toContain(`# Document 1: /docs/${'x'.repeat(113)}…\n\nERROR: failed to fetch (HTTP 404`);
    expect(cut).toContain(`# Document 2: /docs/${'x'.repeat(113)}…\n\nThe same page as document 1.`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false);
  });

  it('lists the pages that got no answer in time, to be read again, apart from pages that do not exist', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      seedPage('/docs/guides/map-studio.md', '# Map Studio');
      // The slow page hangs until its fetch is aborted, as a real one would be.
      const original = globalThis.fetch;
      globalThis.fetch = ((input: string, init?: RequestInit) =>
        input === `${BASE}/docs/guides/slow.md`
          ? new Promise<Response>((_, reject) =>
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
            )
          : Promise.resolve(new Response('not found', { status: 404, statusText: 'Not Found' }))) as typeof fetch;
      restore = () => void (globalThis.fetch = original);
      const call = t.client.callTool({
        name: 'read_docs_batch',
        arguments: { urls: ['/docs/guides/map-studio', '/docs/guides/slow', '/docs/guides/missing'] },
      });
      let done = false;
      void call.then(() => (done = true));
      // Step the clock until the slow page gives up (the call reaches the fetch asynchronously).
      for (let waited = 0; !done && waited <= FETCH.batchTimeoutMs; waited += 1_000) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      const text = textOf(await call);
      expect(text).toContain('# Map Studio');
      expect(text).toContain('# Document 3: /docs/guides/missing\n\nERROR: failed to fetch (HTTP 404');
      expect(text).toMatch(
        /1 page\(s\) did not load in time \(the site was slow to answer, or this server busy\)\. Read them with another read_docs_batch call: \["\/docs\/guides\/slow"\]$/
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('is an error when every page fails', async () => {
    ({ restore } = stubFetch({}));
    const result = await t.client.callTool({
      name: 'read_docs_batch',
      arguments: { urls: ['/docs/a', '/docs/b'] },
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('# Document 1: /docs/a\n\nERROR');
    expect(textOf(result)).toContain('# Document 2: /docs/b\n\nERROR');
  });

  it(`shares a ${LIMITS.maxBatchChars}-character budget across the pages and says where to continue`, async () => {
    const big = 'b'.repeat(LIMITS.maxBatchChars);
    seedPage('/docs/big1.md', big);
    seedPage('/docs/big2.md', big);
    seedPage('/docs/small.md', 'tiny');
    const result = await t.client.callTool({
      name: 'read_docs_batch',
      arguments: { urls: ['/docs/big1', '/docs/small', '/docs/big2'] },
    });
    const text = textOf(result);
    expect(text.length).toBeLessThan(LIMITS.maxBatchChars + 1_000);
    // The short page comes whole; what it leaves is shared evenly by the long ones, whatever their order.
    const half = Math.floor((LIMITS.maxBatchChars - 4) / 2);
    const shown = [...text.matchAll(/Showing the first (\d+) of/g)].map((m) => Number(m[1]));
    expect(shown).toEqual([half, half]);
    expect(text).toContain(
      `(Showing the first ${half} of ${big.length} characters. Read the rest with read_doc, offset: ${half}.)`
    );
    expect(text).toContain('# Document 2: https://developer.magiclane.com/docs/small\n\ntiny');
    expect(text).not.toContain('Showing the first 4 of');
  });

  it('returns a page given twice, in any spelling, once', async () => {
    seedPage('/docs/twice.md', 'twice body');
    const text = textOf(
      await t.client.callTool({
        name: 'read_docs_batch',
        arguments: { urls: ['/docs/twice', 'https://developer.magiclane.com/docs/Twice.md', 'docs//twice'] },
      })
    );
    expect(text.match(/twice body/g)).toHaveLength(1);
    expect(text).toContain('# Document 2: https://developer.magiclane.com/docs/Twice\n\nThe same page as document 1.');
    expect(text).toContain('# Document 3: docs//twice\n\nThe same page as document 1.');
  });

  it("gives a failed page's share to the pages that loaded", async () => {
    const urls = Array.from({ length: 5 }, (_, i) => `/docs/share${i}`);
    for (const u of urls.slice(0, 4)) seedPage(`${u}.md`, 's'.repeat(LIMITS.maxBatchChars));
    ({ restore } = stubFetch({})); // the fifth page: 404
    const text = textOf(await t.client.callTool({ name: 'read_docs_batch', arguments: { urls } }));
    const shown = [...text.matchAll(/Showing the first (\d+) of/g)].map((m) => Number(m[1]));
    expect(shown).toEqual(Array(4).fill(LIMITS.maxBatchChars / 4));
    expect(text).toContain('# Document 5: /docs/share4\n\nERROR');
  });

  it('never cuts a page below the per-page minimum even when the budget is spent', async () => {
    const urls = Array.from({ length: LIMITS.maxBatchSize }, (_, i) => `/docs/p${i}`);
    for (const u of urls) seedPage(`${u}.md`, 'z'.repeat(LIMITS.maxBatchChars));
    const text = textOf(await t.client.callTool({ name: 'read_docs_batch', arguments: { urls } }));
    const shown = [...text.matchAll(/Showing the first (\d+) of/g)].map((m) => Number(m[1]));
    expect(shown).toHaveLength(LIMITS.maxBatchSize);
    expect(Math.min(...shown)).toBeGreaterThanOrEqual(2_000);
  });

  it('rejects an empty url list, too many urls, and an over-long url with validation errors', async () => {
    expect(isError(await t.client.callTool({ name: 'read_docs_batch', arguments: { urls: [] } }))).toBe(true);
    const tooMany = await t.client.callTool({
      name: 'read_docs_batch',
      arguments: { urls: Array.from({ length: LIMITS.maxBatchSize + 1 }, (_, i) => `/docs/p${i}`) },
    });
    expect(isError(tooMany)).toBe(true);
    expect(textOf(tooMany)).toContain(`at most ${LIMITS.maxBatchSize} element`);
    const long = await t.client.callTool({
      name: 'read_docs_batch',
      arguments: { urls: ['/docs/' + 'x'.repeat(LIMITS.maxRefChars)] },
    });
    expect(isError(long)).toBe(true);
  });
});
