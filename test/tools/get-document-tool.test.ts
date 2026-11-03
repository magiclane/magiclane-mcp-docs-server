/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectClient, GET_STARTED_PAGE, isError, seedFixtures, seedPage, stubFetch, textOf } from '../helpers.js';
import { LIMITS } from '../../src/config/constants.js';
import { rangeNote } from '../../src/tools/get-document-tool.js';
import type { TestClient } from '../helpers.js';

describe('read_doc', () => {
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

  it('fetches a page by docs path and prefixes the resolved URL and the totals', async () => {
    const result = await t.client.callTool({ name: 'read_doc', arguments: { url: '/docs/guides/get-started' } });
    const text = textOf(result);
    expect(text).toContain('# Document: https://developer.magiclane.com/docs/guides/get-started');
    expect(text).toContain(`(Complete page: ${GET_STARTED_PAGE.length} characters.)`);
    expect(text).toContain(GET_STARTED_PAGE.trim().split('\n')[0]);
    expect(isError(result)).toBe(false);
  });

  it('accepts full developer.magiclane.com URLs, query strings and all', async () => {
    const result = await t.client.callTool({
      name: 'read_doc',
      arguments: { url: 'https://developer.magiclane.com/docs/guides/get-started.md?from=search#x' },
    });
    expect(textOf(result)).toContain('Create your free Magic Lane account');
  });

  it('pages through long documents with offset and maxChars, reporting the real total', async () => {
    const body = 'x'.repeat(50);
    seedPage('/docs/long.md', body);
    const first = textOf(await t.client.callTool({ name: 'read_doc', arguments: { url: '/docs/long', maxChars: 20 } }));
    expect(first).toContain(
      '(Showing characters 0–20 of 50. 30 remain — call again with offset: 20 for the next chunk.)'
    );
    expect(first.endsWith('x'.repeat(20))).toBe(true);
    const last = textOf(
      await t.client.callTool({ name: 'read_doc', arguments: { url: '/docs/long', offset: 40, maxChars: 20 } })
    );
    expect(last).toContain('(Showing characters 40–50 of 50. This is the end of the page.)');
    expect(last).not.toContain('Use offset');
  });

  it('counts and slices the text it returns: links already as web pages', async () => {
    // A link to a page's .md address is 3 characters shorter as the web page it is returned as.
    const body = 'See [Routing](/docs/flutter/routing.md) and [Maps](/docs/flutter/maps.md).';
    seedPage('/docs/links.md', body);
    const web = body.replaceAll('.md)', ')').replaceAll('(/docs/', '(https://developer.magiclane.com/docs/');
    const whole = textOf(await t.client.callTool({ name: 'read_doc', arguments: { url: '/docs/links' } }));
    expect(whole).toContain(`(Complete page: ${web.length} characters.)`);
    expect(whole.endsWith(web)).toBe(true);
    // Paging cuts the returned text, not its source: the chunks join up to the page.
    const cut = 55; // inside the first link's web form
    const first = textOf(
      await t.client.callTool({ name: 'read_doc', arguments: { url: '/docs/links', maxChars: cut } })
    );
    expect(first).toContain(`(Showing characters 0–${cut} of ${web.length}.`);
    expect(first.endsWith(web.slice(0, cut))).toBe(true);
    const rest = textOf(
      await t.client.callTool({ name: 'read_doc', arguments: { url: '/docs/links', offset: cut, maxChars: 1_000 } })
    );
    expect(rest.endsWith(web.slice(cut))).toBe(true);
  });

  it('can reach the end of a page longer than the old 200k cap', async () => {
    const body = 'a'.repeat(LIMITS.maxDocumentChars + 5000) + 'THE END';
    seedPage('/docs/huge.md', body);
    const tail = textOf(
      await t.client.callTool({
        name: 'read_doc',
        arguments: { url: '/docs/huge', offset: LIMITS.maxDocumentChars, maxChars: 10_000 },
      })
    );
    expect(tail).toContain(`of ${body.length}.`);
    expect(tail.endsWith('THE END')).toBe(true);
  });

  it(`returns ${LIMITS.defaultDocumentChars} characters by default with a paging hint`, async () => {
    seedPage('/docs/big.md', 'y'.repeat(LIMITS.defaultDocumentChars + 10));
    const text = textOf(await t.client.callTool({ name: 'read_doc', arguments: { url: '/docs/big' } }));
    expect(text).toContain(
      `(Showing characters 0–${LIMITS.defaultDocumentChars} of ${LIMITS.defaultDocumentChars + 10}.`
    );
    expect(text).toContain(`call again with offset: ${LIMITS.defaultDocumentChars}`);
  });

  it('refuses an offset beyond the page instead of returning an empty chunk', async () => {
    const result = await t.client.callTool({
      name: 'read_doc',
      arguments: { url: '/docs/guides/get-started', offset: 99_999 },
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('offset 99999 is beyond the end of the page');
    // The page was fetched fine: the error does not say it failed to.
    expect(textOf(result)).not.toContain('Failed to fetch');
  });

  it('rejects a negative offset, an over-long URL and a missing url with validation errors', async () => {
    const negative = await t.client.callTool({ name: 'read_doc', arguments: { url: '/docs/x', offset: -1 } });
    expect(isError(negative)).toBe(true);
    const long = await t.client.callTool({
      name: 'read_doc',
      arguments: { url: '/docs/' + 'x'.repeat(LIMITS.maxRefChars) },
    });
    expect(isError(long)).toBe(true);
    expect(textOf(long)).toContain(`at most ${LIMITS.maxRefChars} character`);
    const missing = await t.client.callTool({ name: 'read_doc', arguments: {} });
    expect(isError(missing)).toBe(true);
  });

  it('returns isError for non-magiclane URLs without crashing the server', async () => {
    const result = await t.client.callTool({ name: 'read_doc', arguments: { url: 'https://docs.example/x' } });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('Only https://developer.magiclane.com');
    // A reference with line breaks is quoted on one line: it cannot add a heading of its own to the reply.
    const folded = await t.client.callTool({ name: 'read_doc', arguments: { url: 'javascript:x\n\n# Fake heading' } });
    expect(textOf(folded)).toContain('Failed to fetch document "javascript:x # Fake heading": Only https://');
    expect(textOf(folded)).not.toContain('\n# Fake heading');
    expect(isError(await t.client.callTool({ name: 'read_doc', arguments: { url: '/docs/guides/get-started' } }))).toBe(
      false
    );
  });

  it('reports a 404 and an HTML answer as fetch failures', async () => {
    ({ restore } = stubFetch({
      'https://developer.magiclane.com/docs/html.md': () =>
        new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    }));
    const missing = await t.client.callTool({ name: 'read_doc', arguments: { url: '/docs/missing' } });
    expect(isError(missing)).toBe(true);
    expect(textOf(missing)).toContain('HTTP 404');
    const html = await t.client.callTool({ name: 'read_doc', arguments: { url: '/docs/html' } });
    expect(isError(html)).toBe(true);
    expect(textOf(html)).toContain('Not a documentation page (HTML response)');
  });
});

describe('rangeNote', () => {
  it('covers the complete, more-to-come and final-chunk cases', () => {
    expect(rangeNote(0, 5, 5, false)).toBe('(Complete page: 5 characters.)');
    expect(rangeNote(0, 5, 9, true)).toContain('4 remain — call again with offset: 5');
    expect(rangeNote(5, 9, 9, false)).toContain('This is the end of the page.');
  });
});
