/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Page links as the web pages people open: the .md address a tool reads —
 * absolute, http or https, .MD too, or relative inside page text — becomes the
 * page's web address, in text and at any depth of structured content; not an
 * index file, another extension, another host, or the address a fetch failed
 * for. The tools' use of it is tested in test/tools/base-tool.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { webPageLinks, webPageUrls } from '../../src/utils/page-links.js';

const SITE = 'https://developer.magiclane.com/docs';

describe('webPageLinks', () => {
  it('rewrites a page .md address, in any case and scheme, however the link ends', () => {
    expect(webPageLinks(`${SITE}/guides/get-started.md`)).toBe(`${SITE}/guides/get-started`);
    expect(webPageLinks('http://developer.magiclane.com/docs/x.MD.')).toBe(`${SITE}/x.`);
    expect(
      webPageLinks(
        `(${SITE}/a.md) [${SITE}/b.md] "${SITE}/c.md" <${SITE}/d.md> ${SITE}/e.md#part ${SITE}/f.md?q=1, ${SITE}/g.md`
      )
    ).toBe(`(${SITE}/a) [${SITE}/b] "${SITE}/c" <${SITE}/d> ${SITE}/e#part ${SITE}/f?q=1, ${SITE}/g`);
  });

  it('rewrites the two pages whose path holds an underscore, plain, bold, italic or in a table cell', () => {
    const pages = ['ios/examples/maps-3dscene/map_update', 'ios/examples/places-search/search_category'];
    for (const page of pages) {
      expect(webPageLinks(`${SITE}/${page}.md`), page).toBe(`${SITE}/${page}`);
      const marked = (ext: string): string =>
        `**${SITE}/${page}${ext}** _${SITE}/${page}${ext}_ | ${SITE}/${page}${ext} | [t](${SITE}/${page}${ext}#x)`;
      expect(webPageLinks(marked('.md')), page).toBe(marked(''));
    }
  });

  it('leaves index files, other extensions, other hosts and the address a fetch failed for', () => {
    const others = `${SITE}/llms.txt ${SITE}/llms-full.txt ${SITE}/x.mdx https://example.com/docs/a.md`;
    expect(webPageLinks(others)).toBe(others);
    const failed = `HTTP 404 Not Found for ${SITE}/flutter/no-such-page.md`;
    expect(webPageLinks(failed)).toBe(failed);
    expect(webPageLinks('')).toBe('');
  });

  it('rewrites a relative page link inside page text, with its anchor, but not other relative files', () => {
    expect(
      webPageLinks('See [Routing](/docs/flutter/guides/routing.md#calc) and **[Maps](/docs/flutter/maps.MD)**.')
    ).toBe(`See [Routing](${SITE}/flutter/guides/routing#calc) and **[Maps](${SITE}/flutter/maps)**.`);
    const files = '[img](/docs/a.png) [idx](/docs/llms.txt) [elsewhere](/blog/a.md) /docs/a.md';
    expect(webPageLinks(files)).toBe(files);
  });
});

describe('webPageUrls', () => {
  it('rewrites the links in strings at any depth, and leaves a path and the other values as they are', () => {
    const content = {
      url: `${SITE}/a.md`,
      path: '/docs/a.md',
      total: 2,
      ok: true,
      missing: null,
      items: [{ url: `${SITE}/b_c.md`, excerpt: `See ${SITE}/d.md now.` }, 'plain', 7],
      nested: { deeper: [`${SITE}/e.md#f`] },
    };
    expect(webPageUrls(content)).toEqual({
      url: `${SITE}/a`,
      path: '/docs/a.md',
      total: 2,
      ok: true,
      missing: null,
      items: [{ url: `${SITE}/b_c`, excerpt: `See ${SITE}/d now.` }, 'plain', 7],
      nested: { deeper: [`${SITE}/e#f`] },
    });
    expect(webPageUrls(`${SITE}/a.md`)).toBe(`${SITE}/a`);
    expect(webPageUrls(undefined)).toBeUndefined();
  });
});
