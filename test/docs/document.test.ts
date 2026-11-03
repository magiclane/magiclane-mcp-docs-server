/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
// cspell:ignore lutter Dmap
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDocument, normalizeDocRef, sliceDocument } from '../../src/docs/document.js';
import { LIMITS } from '../../src/config/constants.js';
import { BASE, GET_STARTED_BODY, resetCaches, seedFixtures, seedPage, stubFetch } from '../helpers.js';

const url = (path: string): string => normalizeDocRef(path).url;

describe('normalizeDocRef', () => {
  it('appends .md to extension-less docs paths and reports the path', () => {
    expect(normalizeDocRef('/docs/guides/get-started')).toEqual({
      url: `${BASE}/docs/guides/get-started.md`,
      path: '/docs/guides/get-started.md',
    });
  });

  it('keeps .md and .txt references, lower-casing the extension', () => {
    expect(url('/docs/guides/get-started.md')).toBe(`${BASE}/docs/guides/get-started.md`);
    expect(url('/docs/flutter/llms.txt')).toBe(`${BASE}/docs/flutter/llms.txt`);
    expect(url('/docs/guides/get-started.MD')).toBe(`${BASE}/docs/guides/get-started.md`);
  });

  it('strips trailing slashes — in linear time, however many there are', () => {
    expect(url('/docs/guides/get-started///')).toBe(`${BASE}/docs/guides/get-started.md`);
    const started = performance.now();
    expect(() => normalizeDocRef(`${BASE}/${'/'.repeat(LIMITS.maxRefChars - 40)}a`)).not.toThrow();
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('folds every spelling of one page onto one URL: case, doubled slashes, escaped letters', () => {
    const canonical = `${BASE}/docs/flutter/examples/hello-map.md`;
    for (const variant of [
      '/docs/Flutter/Examples/Hello-Map',
      '/DOCS/flutter//examples///hello-map/',
      `${BASE}//docs/flutter/examples/hello-map.MD`,
      '/docs/%66lutter/examples/hello%2Dmap',
    ]) {
      expect(url(variant), variant).toBe(canonical);
    }
    // Escapes of reserved characters are kept (lower-cased), not decoded into structure.
    // Encoded slashes are separators: no spelling gets a path past the checks.
    expect(url('/docs/a%2Fb')).toBe(`${BASE}/docs/a/b.md`);
    expect(url('/docs/a%5cb')).toBe(`${BASE}/docs/a/b.md`);
    // Other reserved escapes stay escaped.
    expect(url('/docs/a%20b')).toBe(`${BASE}/docs/a%20b.md`);
    expect(() => normalizeDocRef('/docs/flutter%2fllms-full.txt')).toThrow(/use search_docs/);
    // Dot segments an encoded slash produces are resolved before the /docs check, as written ones are.
    expect(url('/docs/flutter/..%2f/android/x')).toBe(`${BASE}/docs/android/x.md`);
    expect(url('/docs/..%2f/..%2f/etc/passwd')).toBe(`${BASE}/docs/etc/passwd.md`);
    expect(url('/docs/a/.%5Cb/./c')).toBe(`${BASE}/docs/a/b/c.md`);
    expect(url('/docs/a/../../x')).toBe(`${BASE}/docs/x.md`);
    // http:// is upgraded, and its default port with it.
    expect(url('http://developer.magiclane.com:80/docs/x')).toBe(`${BASE}/docs/x.md`);
  });

  it('refuses other schemes, converts backslashes and strips .html', () => {
    for (const bad of [
      'ftp://developer.magiclane.com/docs/x',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'mailto:a@b',
    ]) {
      expect(() => normalizeDocRef(bad), bad).toThrow(/Only https:\/\/developer\.magiclane\.com/);
    }
    expect(url('developer.magiclane.com:443/docs/x')).toBe(`${BASE}/docs/x.md`);
    expect(url('\\docs\\flutter\\examples\\hello-map')).toBe(`${BASE}/docs/flutter/examples/hello-map.md`);
    expect(url('/docs/flutter/examples/hello-map.html')).toBe(`${BASE}/docs/flutter/examples/hello-map.md`);
    expect(url('/docs/flutter/llms.txt')).toBe(`${BASE}/docs/flutter/llms.txt`);
    expect(() => normalizeDocRef('/docs/flutter/llms-full.txt')).toThrow(/use search_docs/);
  });

  it('drops query strings and fragments before adding .md', () => {
    expect(url(`${BASE}/docs/flutter/examples/routing?from=search#calculate`)).toBe(
      `${BASE}/docs/flutter/examples/routing.md`
    );
  });

  it('repairs a source path given without /docs, a relative path, and a bare host', () => {
    expect(url('/flutter/examples/hello-map')).toBe(`${BASE}/docs/flutter/examples/hello-map.md`);
    expect(url('docs/flutter/examples/hello-map')).toBe(`${BASE}/docs/flutter/examples/hello-map.md`);
    expect(url('flutter/examples/hello-map')).toBe(`${BASE}/docs/flutter/examples/hello-map.md`);
    expect(url('developer.magiclane.com/docs/flutter/examples/hello-map')).toBe(
      `${BASE}/docs/flutter/examples/hello-map.md`
    );
    expect(url(`${BASE}/flutter/examples/hello-map`)).toBe(`${BASE}/docs/flutter/examples/hello-map.md`);
    expect(url(`${BASE}/`)).toBe(`${BASE}/docs.md`);
  });

  it('upgrades cleartext http and protocol-relative references on the developer host', () => {
    expect(url('http://developer.magiclane.com/docs/guides/get-started')).toBe(`${BASE}/docs/guides/get-started.md`);
    expect(url('//developer.magiclane.com/docs/guides/get-started')).toBe(`${BASE}/docs/guides/get-started.md`);
  });

  it('rejects other hosts, lookalikes, other subdomains, ports and credentials', () => {
    for (const bad of [
      'https://docs.example/docs/x',
      'https://developer.magiclane.com.evil.example/docs/x',
      'https://xdeveloper.magiclane.com/docs/x',
      'https://api.magiclane.com/docs/x',
    ]) {
      expect(() => normalizeDocRef(bad)).toThrow(/Only https:\/\/developer\.magiclane\.com/);
    }
    // On the docs host itself, the message names what is wrong.
    expect(() => normalizeDocRef('https://developer.magiclane.com:8443/docs/x')).toThrow(
      /default https port; got port 8443/
    );
    expect(() => normalizeDocRef('https://user:pw@developer.magiclane.com/docs/x')).toThrow(/carry no credentials/);
    expect(() => normalizeDocRef('https://user@developer.magiclane.com/docs/x')).toThrow(/carry no credentials/);
  });

  it('rejects empty, over-long and malformed references with clear messages', () => {
    expect(() => normalizeDocRef('   ')).toThrow(/Empty/);
    expect(() => normalizeDocRef('x'.repeat(LIMITS.maxRefChars + 1))).toThrow(/too long/);
    expect(() => normalizeDocRef('https://[::1')).toThrow(/Not a valid documentation URL/);
  });
});

describe('getDocument', () => {
  let restore = (): void => {};

  beforeEach(() => {
    seedFixtures();
  });

  afterEach(() => {
    restore();
    restore = () => {};
  });

  it('fetches a page by docs path and strips heading anchor artifacts', async () => {
    seedPage('/docs/x.md', '## Setup[​](#setup "Direct link to Setup")\n\nBody');
    const doc = await getDocument('/docs/x');
    expect(doc).toEqual({ url: `${BASE}/docs/x.md`, path: '/docs/x.md', content: '## Setup\n\nBody' });
    expect((await getDocument('/docs/guides/get-started')).content).toContain(GET_STARTED_BODY);
  });

  it('never fetches a second URL: a missing page is a 404, not an HTML fallback', async () => {
    resetCaches();
    const stub = stubFetch({});
    restore = stub.restore;
    await expect(getDocument('/docs/guides/missing')).rejects.toThrow('HTTP 404');
    expect(stub.calls).toEqual([`${BASE}/docs/guides/missing.md`]);
  });

  it('rejects an HTML answer instead of returning the site shell as a page', async () => {
    resetCaches();
    ({ restore } = stubFetch({
      [`${BASE}/docs/flutter.md`]: () =>
        new Response('<html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    }));
    await expect(getDocument('/docs/flutter')).rejects.toThrow('Not a documentation page (HTML response)');
  });

  it('rejects non-magiclane references before any fetch', async () => {
    const stub = stubFetch({});
    restore = stub.restore;
    await expect(getDocument('https://docs.example/docs/x')).rejects.toThrow('Only https://developer.magiclane.com');
    expect(stub.calls).toEqual([]);
  });
});

describe('sliceDocument', () => {
  it('always advances, even with maxChars 1 at a character outside the BMP', () => {
    const text = 'a\u{1F600}b';
    expect(sliceDocument(text, 1, 1)).toMatchObject({ text: '\u{1F600}', start: 1, end: 3, hasMore: true });
    expect(sliceDocument(text, 0, 2)).toMatchObject({ text: 'a', end: 1 });
    expect(sliceDocument(text, 3, 1)).toMatchObject({ text: 'b', end: 4, hasMore: false });
  });

  it('returns the whole page when it fits', () => {
    expect(sliceDocument('abc', 0, 10)).toEqual({ text: 'abc', total: 3, start: 0, end: 3, hasMore: false });
  });

  it('pages with honest totals and a hasMore flag', () => {
    expect(sliceDocument('abcdef', 0, 4)).toEqual({ text: 'abcd', total: 6, start: 0, end: 4, hasMore: true });
    expect(sliceDocument('abcdef', 4, 4)).toEqual({ text: 'ef', total: 6, start: 4, end: 6, hasMore: false });
  });

  it('refuses an offset beyond the page instead of returning an empty chunk', () => {
    expect(() => sliceDocument('abcdef', 6, 4)).toThrow('offset 6 is beyond the end of the page (6 characters)');
    expect(() => sliceDocument('', 0, 4)).not.toThrow();
  });

  it('never splits a surrogate pair at either edge', () => {
    const text = 'a😀b😀c'; // 😀 is two UTF-16 units
    const first = sliceDocument(text, 0, 2); // would end inside the first emoji
    expect(first.end).toBe(1);
    expect(first.text).toBe('a');
    const second = sliceDocument(text, 2, 10); // would start inside the first emoji
    expect(second.start).toBe(1);
    expect(second.text).toBe('😀b😀c');
  });
});
