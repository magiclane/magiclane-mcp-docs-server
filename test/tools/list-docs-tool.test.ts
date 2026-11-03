/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectClient, FLUTTER_LLMS, isError, resetCaches, seedFixtures, stubFetch, textOf } from '../helpers.js';
import type { TestClient } from '../helpers.js';

const failedSourcesOf = (result: unknown): unknown[] =>
  (result as { structuredContent: { failedSources: unknown[] } }).structuredContent.failedSources;
import { seedIndex } from '../../src/docs/docs-index.js';
import { DOCS, LIMITS } from '../../src/config/constants.js';
import { BRIEF_DESCRIPTION_CHARS, briefDescription } from '../../src/tools/output-schemas.js';

describe('list_docs', () => {
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

  it('defaults to a compact sections TOC for source=all, with URL-derived sections', async () => {
    const result = await t.client.callTool({ name: 'list_docs', arguments: {} });
    const text = textOf(result);
    expect(text).toMatch(/^\d+ pages across \d+ source\(s\)/);
    expect(text).toContain('(source: developer)');
    expect(text).toContain('- Guides — 2 pages');
    expect(text).toContain('- Guides › Map Studio — 1 page');
    expect(text).toContain('- Examples › Routing & Navigation — 3 pages');
    expect(text).not.toContain('](https://');
  });

  it('lists every page for source=all when mode=pages is explicit', async () => {
    const text = textOf(await t.client.callTool({ name: 'list_docs', arguments: { mode: 'pages' } }));
    expect(text).toContain('[Get Started](https://developer.magiclane.com/docs/guides/get-started)');
    expect(text).toContain('## Examples › Routing & Navigation');
    expect(text).toContain('[Calculate Route](');
  });

  it('supports an explicit sections TOC for a single source', async () => {
    const text = textOf(
      await t.client.callTool({ name: 'list_docs', arguments: { source: 'flutter', mode: 'sections' } })
    );
    expect(text).toContain('(source: flutter)');
    expect(text).not.toContain('(source: developer)');
    expect(text).not.toContain('](https://');
  });

  it('filters by source and defaults to full pages for a single source', async () => {
    const text = textOf(await t.client.callTool({ name: 'list_docs', arguments: { source: 'flutter' } }));
    expect(text).toMatch(/^7 pages/);
    expect(text).toContain(
      '[Draw Route](https://developer.magiclane.com/docs/flutter/examples/routing-navigation/draw-route)'
    );
    expect(text).not.toContain('(source: developer)');
  });

  it('filters by section, case-insensitively, and the filter is what the TOC shows', async () => {
    const text = textOf(await t.client.callTool({ name: 'list_docs', arguments: { section: 'ROUTING' } }));
    expect(text).toContain('[Calculate Route](');
    expect(text).not.toContain('[Add Markers](');
    const exact = textOf(
      await t.client.callTool({ name: 'list_docs', arguments: { section: 'Examples › Maps & 3D Scene' } })
    );
    expect(exact).toContain('[Add Markers](');
    // A blank filter is no filter: the TOC, as with none given; spaces around a filter do not count.
    const blank = textOf(await t.client.callTool({ name: 'list_docs', arguments: { section: '  ' } }));
    expect(blank).toBe(textOf(await t.client.callTool({ name: 'list_docs', arguments: {} })));
    const padded = textOf(await t.client.callTool({ name: 'list_docs', arguments: { section: ' routing ' } }));
    expect(padded).toContain('[Calculate Route](');
  });

  it('explains when nothing matches the filters and points at the TOC', async () => {
    const result = await t.client.callTool({ name: 'list_docs', arguments: { section: 'nope' } });
    expect(isError(result)).toBe(false);
    expect(textOf(result)).toContain(
      'No documentation pages match the given filters (section "nope"). Call list_docs with mode "sections"'
    );
    // A section with line breaks is quoted on one line: it cannot add a heading of its own to the reply.
    const folded = textOf(
      await t.client.callTool({ name: 'list_docs', arguments: { section: 'nope\n\n# Fake heading' } })
    );
    expect(folded).toContain('(section "nope # Fake heading"). Call list_docs');
    expect(folded).not.toContain('\n# Fake heading');
  });

  it('reports an index that lists no pages as a source that failed, never as "no documentation"', async () => {
    seedIndex('developer', '# Empty\n\n## Docs\n');
    const result = await t.client.callTool({ name: 'list_docs', arguments: { source: 'developer' } });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('- developer index (llms.txt): the index lists no pages');
    // An empty file is a publishing problem, not connectivity — and no retry will help.
    expect(textOf(result)).toContain(
      'This is a problem with the file(s) published on developer.magiclane.com (not found, empty, or not in the ' +
        'llms.txt format), not a documentation gap.'
    );
    expect(textOf(result)).not.toContain('retry shortly');
    const all = await t.client.callTool({ name: 'list_docs', arguments: {} });
    expect(textOf(all)).toContain('## Sources not loaded');
    expect(textOf(all)).toContain('a problem with the file(s) published on developer.magiclane.com');
    expect(failedSourcesOf(all)).toEqual([
      { source: 'developer', part: 'index', reason: expect.stringContaining('lists no pages'), kind: 'file' },
    ]);
  });

  it('tells an unreachable host apart from broken files, and a mix of both', async () => {
    const down = (): Promise<Response> => Promise.reject(new TypeError('fetch failed'));
    const unreachable = Object.fromEntries(DOCS.sources.map((s) => [s.indexUrl, down]));
    resetCaches();
    seedIndex('flutter', FLUTTER_LLMS);
    ({ restore } = stubFetch(unreachable));
    const outage = textOf(await t.client.callTool({ name: 'list_docs', arguments: {} }));
    expect(outage).toContain('a problem reaching developer.magiclane.com, not a gap in the documentation');
    restore();
    resetCaches();
    seedIndex('flutter', FLUTTER_LLMS);
    seedIndex('developer', '# Empty\n\n## Docs\n');
    ({ restore } = stubFetch(unreachable));
    const mixed = textOf(await t.client.callTool({ name: 'list_docs', arguments: {} }));
    expect(mixed).toContain('a problem reaching developer.magiclane.com, and with file(s) published there');
    restore();
    resetCaches();
    ({ restore } = stubFetch(unreachable));
    const none = await t.client.callTool({ name: 'list_docs', arguments: { source: 'android' } });
    expect(textOf(none)).toContain('not a documentation gap — retry shortly');
  });

  it('explains a section filter that matches nothing', async () => {
    const text = textOf(
      await t.client.callTool({ name: 'list_docs', arguments: { source: 'developer', section: 'nowhere' } })
    );
    expect(text).toContain('No documentation pages match the given filters (section "nowhere"). Call list_docs');
  });

  it('labels top-level pages in the TOC and lists them without a section header', async () => {
    seedIndex('developer', '- [Top](/docs/top.md)\n');
    const toc = textOf(
      await t.client.callTool({ name: 'list_docs', arguments: { source: 'developer', mode: 'sections' } })
    );
    expect(toc).toContain('- (top level) — 1 page');
    expect(toc).not.toContain('1 pages');
    const pages = textOf(await t.client.callTool({ name: 'list_docs', arguments: { source: 'developer' } }));
    expect(pages).toContain('# Magic Lane Guides');
    expect(pages).not.toContain('## ');
    // The TOC's label works as a section filter.
    const top = await t.client.callTool({
      name: 'list_docs',
      arguments: { source: 'developer', section: '(Top Level)' },
    });
    expect((top.structuredContent as { total: number }).total).toBe(1);
  });

  it(`returns ${LIMITS.defaultListPages} pages per call by default, even for a single source`, async () => {
    const many = Array.from({ length: 120 }, (_, i) => `- [Page ${i}](/docs/flutter/p/page-${i}.md): Text.`).join('\n');
    seedIndex('flutter', many);
    const text = textOf(await t.client.callTool({ name: 'list_docs', arguments: { source: 'flutter' } }));
    expect(text).toContain(
      `Showing pages 1–${LIMITS.defaultListPages} of 120. Call again with offset: ${LIMITS.defaultListPages}`
    );
  });

  it('pages a long listing with offset and limit', async () => {
    const first = textOf(await t.client.callTool({ name: 'list_docs', arguments: { source: 'flutter', limit: 3 } }));
    expect(first).toContain('Showing pages 1–3 of 7. Call again with offset: 3 for the next 3.');
    const last = textOf(
      await t.client.callTool({ name: 'list_docs', arguments: { source: 'flutter', offset: 6, limit: 3 } })
    );
    expect(last).toContain('Showing pages 7–7 of 7 (end of listing).');
    const beyond = await t.client.callTool({ name: 'list_docs', arguments: { source: 'flutter', offset: 7 } });
    expect(isError(beyond)).toBe(true);
    expect(textOf(beyond)).toContain('offset 7 is beyond the end of the listing (7 pages)');
    const tooMany = await t.client.callTool({ name: 'list_docs', arguments: { limit: LIMITS.maxListPages + 1 } });
    expect(isError(tooMany)).toBe(true);
  });

  it('carries the whole listing in its structured content, paging included', async () => {
    const toc = (await t.client.callTool({ name: 'list_docs', arguments: {} })).structuredContent;
    expect(toc).toMatchObject({ mode: 'sections', pages: [], offset: 0, failedSources: [] });
    expect(toc).toHaveProperty('message', expect.stringMatching(/^\d+ pages across \d+ source\(s\)/));
    expect((toc as { sections: unknown[] }).sections).toContainEqual({
      source: 'flutter',
      section: 'Examples › Routing & Navigation',
      pages: 3,
    });
    const first = (await t.client.callTool({ name: 'list_docs', arguments: { source: 'flutter', limit: 3 } }))
      .structuredContent as { pages: Array<Record<string, string>> };
    expect(first).toMatchObject({ mode: 'pages', total: 7, offset: 0, nextOffset: 3, sections: [] });
    expect(first.pages).toHaveLength(3);
    expect(first.pages[0]).toEqual({
      title: expect.any(String),
      url: expect.stringMatching(/^https:\/\/developer\.magiclane\.com\/docs\/flutter\//),
      path: expect.stringMatching(/^\/docs\/flutter\//),
      description: expect.any(String),
      source: 'flutter',
      section: expect.any(String),
    });
    const last = (await t.client.callTool({ name: 'list_docs', arguments: { source: 'flutter', offset: 6, limit: 3 } }))
      .structuredContent;
    expect(last).toMatchObject({ offset: 6, message: 'Showing pages 7–7 of 7 (end of listing).' });
    expect(last).not.toHaveProperty('nextOffset');
    const none = (await t.client.callTool({ name: 'list_docs', arguments: { section: 'nope' } })).structuredContent;
    expect(none).toMatchObject({
      total: 0,
      pages: [],
      message: expect.stringContaining('No documentation pages match'),
    });
  });

  it('names sources that could not be loaded and errors when none could', async () => {
    resetCaches();
    seedIndex('flutter', FLUTTER_LLMS);
    ({ restore } = stubFetch({}));
    const partial = await t.client.callTool({ name: 'list_docs', arguments: {} });
    expect(isError(partial)).toBe(false);
    expect(textOf(partial)).toContain('## Sources not loaded');
    expect(textOf(partial)).toContain('- developer index (llms.txt): HTTP 404');
    const none = await t.client.callTool({ name: 'list_docs', arguments: { source: 'android' } });
    expect(isError(none)).toBe(true);
    expect(textOf(none)).toContain('Could not load the documentation index');
    expect(textOf(none)).toContain('so nothing was listed');
  });

  it('lists an SDK source added via config (ios)', async () => {
    const text = textOf(await t.client.callTool({ name: 'list_docs', arguments: { source: 'ios' } }));
    expect(text).toContain('[Get Started (ios)](https://developer.magiclane.com/docs/ios/guides/get-started)');
  });

  it('rejects an unknown source and an over-long section filter with validation errors', async () => {
    expect(isError(await t.client.callTool({ name: 'list_docs', arguments: { source: 'nope' } }))).toBe(true);
    const long = await t.client.callTool({
      name: 'list_docs',
      arguments: { section: 'x'.repeat(LIMITS.maxFilterChars + 1) },
    });
    expect(isError(long)).toBe(true);
    expect(textOf(long)).toContain(`at most ${LIMITS.maxFilterChars} character`);
  });
});

describe('briefDescription', () => {
  it('keeps a short description, else its first sentence, else cuts it at a word', () => {
    expect(briefDescription('Short one. Another.')).toBe('Short one. Another.');
    const sentence = 'Stream turn-by-turn navigation over Bluetooth Low Energy.';
    expect(briefDescription(`${sentence} ${'More detail follows here. '.repeat(10)}`)).toBe(sentence);
    const long = `${'word '.repeat(60)}end`;
    const cut = briefDescription(long);
    expect(cut.endsWith('word…')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(BRIEF_DESCRIPTION_CHARS);
    // A first sentence that is itself too long is cut too; a cut never ends on punctuation.
    expect(briefDescription(`${'a, '.repeat(120)}b. c`)).toMatch(/a…$/);
    // No space to cut at: cut where the room ends, never inside an emoji.
    expect(briefDescription('x'.repeat(300))).toBe(`${'x'.repeat(BRIEF_DESCRIPTION_CHARS - 1)}…`);
    const emoji = briefDescription(`🚀${'x'.repeat(230)}`);
    expect(emoji.startsWith('🚀xxx')).toBe(true);
    expect(emoji.charCodeAt(1)).toBe(0xde80); // the emoji's second half is kept
    // The cap counts UTF-16 units, so does the cut: 150 emoji (300 units) are cut, not kept whole…
    const many = briefDescription('🚀'.repeat(150));
    expect(many.length).toBeLessThanOrEqual(BRIEF_DESCRIPTION_CHARS);
    expect(many).toBe(`${'🚀'.repeat(99)}…`); // …and never inside one
    // An early space does not cut the description to a word.
    expect(briefDescription(`A ${'x'.repeat(230)}`)).toBe(`A ${'x'.repeat(BRIEF_DESCRIPTION_CHARS - 3)}…`);
    expect(briefDescription(`${'x'.repeat(120)} ${'y'.repeat(120)}`)).toBe(`${'x'.repeat(120)}…`);
    // "e.g." does not end the first sentence.
    expect(briefDescription(`Draw shapes (e.g. polygons) on the map. ${'More. '.repeat(40)}`)).toBe(
      'Draw shapes (e.g. polygons) on the map.'
    );
  });

  it('lists pages with the brief description, in the text and the structured content alike', async () => {
    const t = await connectClient();
    try {
      const long = `First sentence of the page. ${'Then much more about it. '.repeat(20)}`;
      seedIndex('android', `- [Long](/docs/android/long.md): ${long}\n`);
      const result = await t.client.callTool({ name: 'list_docs', arguments: { source: 'android' } });
      expect(textOf(result)).toMatch(/— First sentence of the page\.(\n|$)/);
      expect(textOf(result)).not.toContain('Then much more');
      const pages = (result.structuredContent as { pages: Array<{ description: string }> }).pages;
      expect(pages[0]!.description).toBe('First sentence of the page.');
    } finally {
      await t.close();
    }
  });
});
