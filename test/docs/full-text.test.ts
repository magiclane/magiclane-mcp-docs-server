/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
// cspell:ignore Köln köln Straßen straßen straße über styl
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_FULL_TEXT_REASON,
  attachUrls,
  clearFullTextCache,
  fullTextStats,
  loadFullTextSections,
  peekFullTextSections,
  reconcilePages,
  searchFullText,
  seedFullTextSections,
  splitFullText,
  startsPage,
} from '../../src/docs/full-text.js';
import { parseLlmsTxt, platformPreference, seedIndex } from '../../src/docs/docs-index.js';
import { DOCS } from '../../src/config/constants.js';
import {
  DEVELOPER_SOURCE,
  FLUTTER_FULL,
  FLUTTER_LLMS,
  FLUTTER_SOURCE,
  resetCaches,
  seedFixtures,
  stubFetch,
} from '../helpers.js';

describe('reconcilePages', () => {
  const source = FLUTTER_SOURCE;
  const index = (titles: string[]) =>
    parseLlmsTxt(titles.map((t, i) => `- [${t}](/docs/flutter/p${i}.md)`).join('\n'), source);
  const split = (text: string) => splitFullText(`## Docs\n\n${text}`, 'flutter');

  it("merges back a page's own --- + ### that the split mistook for a page, without mutating the input", () => {
    const pages = split('### One\n\nA\n\n---\n\n### Detail\n\nB\n\n---\n\n### Two\n\nC\n');
    expect(pages.map((p) => p.title)).toEqual(['One', 'Detail', 'Two']);
    const repaired = reconcilePages(pages, index(['One', 'Two']));
    expect(repaired.map((p) => p.title)).toEqual(['One', 'Two']);
    expect(repaired[0]!.body).toBe('A\n\n---\n\n### Detail\n\nB');
    expect(repaired[0]!.bodyLower).toContain('### detail');
    expect(repaired[0]!.words.has('detail')).toBe(true);
    expect(repaired[1]).toBe(pages[2]); // untouched pages are the same objects
    expect(pages.map((p) => p.title)).toEqual(['One', 'Detail', 'Two']);
  });

  it('merges several extra headings of one page, and extra headings of several pages', () => {
    const pages = split(
      '### One\n\nA\n\n---\n\n### D1\n\nB\n\n---\n\n### D2\n\nC\n\n---\n\n### Two\n\nE\n\n---\n\n### D3\n\nF\n'
    );
    const repaired = reconcilePages(pages, index(['One', 'Two']));
    expect(repaired.map((p) => p.title)).toEqual(['One', 'Two']);
    expect(repaired[0]!.body).toBe('A\n\n---\n\n### D1\n\nB\n\n---\n\n### D2\n\nC');
    expect(repaired[1]!.body).toBe('E\n\n---\n\n### D3\n\nF');
  });

  it("merges a page's own heading even when another page has that title, following the index order", () => {
    const pages = split(
      '### Apply Map Style\n\nA\n\n---\n\n### Search\n\nlocal\n\n---\n\n### Two\n\nB\n\n---\n\n### Search\n\nreal\n'
    );
    const repaired = reconcilePages(pages, index(['Apply Map Style', 'Two', 'Search']));
    expect(repaired.map((p) => p.title)).toEqual(['Apply Map Style', 'Two', 'Search']);
    expect(repaired[0]!.body).toBe('A\n\n---\n\n### Search\n\nlocal');
    expect(repaired[2]!.body).toBe('real');
  });

  it("keeps a page whole when its own last heading is the next page's title", () => {
    const pages = split('### Apply Map Style\n\nA\n\n---\n\n### Search\n\nlocal\n\n---\n\n### Search\n\nreal\n');
    const repaired = reconcilePages(pages, index(['Apply Map Style', 'Search']));
    expect(repaired.map((p) => p.title)).toEqual(['Apply Map Style', 'Search']);
    expect(repaired[0]!.body).toBe('A\n\n---\n\n### Search\n\nlocal');
    expect(repaired[1]!.body).toBe('real');
    // Unless the index lists the title twice in a row: then both are pages.
    const twice = reconcilePages(pages, index(['Apply Map Style', 'Search', 'Search']));
    expect(twice).toBe(pages);
    const extra = split('### One\n\nA\n\n---\n\n### Two\n\nB\n\n---\n\n### Two\n\nC\n\n---\n\n### D\n\nE\n');
    const both = reconcilePages(extra, index(['One', 'Two', 'Two']));
    expect(both.map((p) => p.body)).toEqual(['A', 'B', 'C\n\n---\n\n### D\n\nE']);
  });

  it('keeps a page whole when its own text repeats its title as a heading, told apart by its description', () => {
    const described = parseLlmsTxt(
      '- [One](/docs/flutter/p0.md): The first page.\n' +
        '- [Basic Shape Drawer](/docs/flutter/p1.md): Draw circles and polygons on the map.\n' +
        '- [Two](/docs/flutter/p2.md): The second page.\n',
      source
    );
    const pages = split(
      '### One\n\nThe first page.\n\n---\n\n### Basic Shape Drawer\n\nDraw circles and polygons on the map.\n\n' +
        '---\n\n### Basic Shape Drawer\n\nThe drawer, step by step.\n\n---\n\n### Two\n\nThe second page.\n'
    );
    const repaired = reconcilePages(pages, described);
    expect(repaired.map((p) => p.title)).toEqual(['One', 'Basic Shape Drawer', 'Two']);
    expect(repaired[0]!.body).toBe('The first page.');
    expect(repaired[1]!.body).toBe(
      'Draw circles and polygons on the map.\n\n---\n\n### Basic Shape Drawer\n\nThe drawer, step by step.'
    );
  });

  it('tells a page from its own repeated title by the "Last updated:" line pages open with', () => {
    // No description in the index: the export's own page opening decides.
    const pages = split(
      '### One\n\nLast updated: July 1, 2026\n\nA\n\n---\n\n### Basic Shape Drawer\n\nLast updated: July 21, 2026\n\n' +
        'Intro\n\n---\n\n### Basic Shape Drawer\n\nThe drawer, step by step.\n\n---\n\n### Two\n\nLast updated: May 2, 2026\n'
    );
    const repaired = reconcilePages(pages, index(['One', 'Basic Shape Drawer', 'Two']));
    expect(repaired.map((p) => p.title)).toEqual(['One', 'Basic Shape Drawer', 'Two']);
    expect(repaired[1]!.body).toBe(
      'Last updated: July 21, 2026\n\nIntro\n\n---\n\n### Basic Shape Drawer\n\nThe drawer, step by step.'
    );
    // The other way round: a page's last heading is the next page's title.
    const closing = split(
      '### Apply Map Style\n\nLast updated: July 1, 2026\n\nA\n\n---\n\n### Search\n\nlocal\n\n---\n\n' +
        '### Search\n\nLast updated: July 2, 2026\n\nreal\n'
    );
    const fixed = reconcilePages(closing, index(['Apply Map Style', 'Search']));
    expect(fixed[0]!.body).toBe('Last updated: July 1, 2026\n\nA\n\n---\n\n### Search\n\nlocal');
    expect(fixed[1]!.body).toBe('Last updated: July 2, 2026\n\nreal');
  });

  it('takes "Last updated:" for a surer page start than the description, near the start of a page too', () => {
    const described = parseLlmsTxt(
      '- [One](/docs/flutter/p0.md): The first page.\n' +
        '- [Apply Map Style](/docs/flutter/p1.md): Apply a style to the map.\n',
      source
    );
    // The page opens with its date, then repeats its title and description under its own heading.
    const pages = split(
      '### One\n\nLast updated: May 1, 2026\n\nA\n\n---\n\n### Apply Map Style\n\nLast updated: July 1, 2026\n\n' +
        '---\n\n### Apply Map Style\n\nApply a style to the map, step by step.\n'
    );
    const repaired = reconcilePages(pages, described);
    expect(repaired.map((p) => p.title)).toEqual(['One', 'Apply Map Style']);
    expect(repaired[0]!.body).toBe('Last updated: May 1, 2026\n\nA');
    expect(repaired[1]!.body).toMatch(/^Last updated: July 1, 2026\n\n---\n\n### Apply Map Style\n\nApply a style/);
  });

  it('keeps a page the index dropped from its middle apart, by its opening, with its own headings', () => {
    const pages = split(
      '### One\n\nLast updated: May 1, 2026\n\nA\n\n---\n\n### Own heading\n\na\n\n---\n\n' +
        '### Dropped\n\nLast updated: May 2, 2026\n\nX\n\n---\n\n### Its heading\n\nx\n\n---\n\n' +
        '### Two\n\nLast updated: May 3, 2026\n\nB\n'
    );
    const entries = index(['One', 'Two']);
    const repaired = reconcilePages(pages, entries);
    expect(repaired.map((p) => p.title)).toEqual(['One', 'Dropped', 'Two']);
    expect(repaired[0]!.body).toBe('Last updated: May 1, 2026\n\nA\n\n---\n\n### Own heading\n\na');
    expect(repaired[1]!.body).toBe('Last updated: May 2, 2026\n\nX\n\n---\n\n### Its heading\n\nx');
    attachUrls(repaired, entries);
    expect(repaired.map((p) => p.url === undefined)).toEqual([false, true, false]);
    // A dropped category page shows its page cards instead of a date: its own pages, in a folder of its own, which
    // the index lists right after it.
    const category = split(
      '### One\n\nLast updated: May 1, 2026\n\nA\n\n---\n\n### Fleet\n\n#### [📄️Two](/docs/flutter/fleet/two.md)\n\nCard.\n\n' +
        '---\n\n### Two\n\nLast updated: May 2, 2026\n\nB\n'
    );
    const fleet = parseLlmsTxt('- [One](/docs/flutter/one.md)\n- [Two](/docs/flutter/fleet/two.md)\n', source);
    expect(reconcilePages(category, fleet).map((p) => p.title)).toEqual(['One', 'Fleet', 'Two']);
    // A page's own cards that link elsewhere, none to the page listed next, are its own "See also".
    const elsewhere = split(
      '### One\n\nLast updated: May 1, 2026\n\nA\n\n---\n\n### See also\n\n#### [📄️Routing](/docs/flutter/routing/a.md)\n\n' +
        'Card.\n\n---\n\n### Two\n\nLast updated: May 2, 2026\n\nB\n'
    );
    const merged = reconcilePages(elsewhere, fleet);
    expect(merged.map((p) => p.title)).toEqual(['One', 'Two']);
    expect(merged[0]!.body).toContain('### See also');
    // A dropped page with neither a date nor cards is told by its title: another number of a series the index
    // lists ("Migrate to 3.1.4" beside "Migrate to 3.1.3"), as no page's own heading is.
    const migrations = split(
      '### Migrate to 3.1.3\n\nThe changes in 3.1.3.\n\n---\n\n### Migrate to 3.1.4\n\nThe changes in 3.1.4.\n\n---\n\n' +
        '### Steps\n\nIts own heading.\n\n---\n\n### Migrate to 3.1.6\n\nThe changes in 3.1.6.\n'
    );
    const series = index(['Migrate to 3.1.3', 'Migrate to 3.1.6']);
    const kept = reconcilePages(migrations, series);
    expect(kept.map((p) => p.title)).toEqual(['Migrate to 3.1.3', 'Migrate to 3.1.4', 'Migrate to 3.1.6']);
    expect(kept[1]!.body).toBe('The changes in 3.1.4.\n\n---\n\n### Steps\n\nIts own heading.');
    attachUrls(kept, series);
    expect(kept.map((p) => p.url === undefined)).toEqual([false, true, false]);
    // A section titled as the next listed page, right before it, is the page before's own heading, not a page.
    const own = split(
      '### Migrate to 3.1.3\n\nThe changes in 3.1.3.\n\n---\n\n### Migrate to 3.1.4\n\nNext, see 3.1.4.\n\n---\n\n' +
        '### Migrate to 3.1.4\n\nThe changes in 3.1.4.\n'
    );
    const listed = reconcilePages(own, index(['Migrate to 3.1.3', 'Migrate to 3.1.4']));
    expect(listed.map((p) => p.title)).toEqual(['Migrate to 3.1.3', 'Migrate to 3.1.4']);
    expect(listed[0]!.body).toBe('The changes in 3.1.3.\n\n---\n\n### Migrate to 3.1.4\n\nNext, see 3.1.4.');
  });

  it('merges a page\'s own heading that lists the pages beside it as cards (a "See also") back into the page', () => {
    // Every card links into the folder of the page before: its own heading, not a category page.
    const pages = split(
      '### One\n\nLast updated: May 1, 2026\n\nA\n\n---\n\n### See also\n\n#### [📄️Two](/docs/flutter/p1.md)\n\nBeside it.\n\n' +
        '---\n\n### Two\n\nLast updated: May 2, 2026\n\nB\n'
    );
    const entries = index(['One', 'Two']);
    const repaired = reconcilePages(pages, entries);
    expect(repaired.map((p) => p.title)).toEqual(['One', 'Two']);
    expect(repaired[0]!.body).toBe(
      'Last updated: May 1, 2026\n\nA\n\n---\n\n### See also\n\n#### [📄️Two](/docs/flutter/p1.md)\n\nBeside it.'
    );
    attachUrls(repaired, entries);
    expect(repaired.map((p) => p.url === undefined)).toEqual([false, false]);
    // After the last listed page too (an image card linking to a page beside it), while cards into another folder are a page.
    const tail = split(
      '### One\n\nLast updated: May 1, 2026\n\nA\n\n---\n\n### See also\n\n[![Two](/docs/flutter/img/two.png)](/docs/flutter/p1)\n\n' +
        '---\n\n### Fleet\n\n#### [📄️Three](/docs/flutter/fleet/p3.md)\n\nCard.\n'
    );
    const fixed = reconcilePages(tail, index(['One']));
    expect(fixed.map((p) => p.title)).toEqual(['One', 'Fleet']);
    expect(fixed[0]!.body).toContain('### See also\n\n[![Two](/docs/flutter/img/two.png)](/docs/flutter/p1)');
    // After a page the index dropped there is no knowing where the page before lives: its cards make it a page.
    const dropped = split(
      '### One\n\nLast updated: May 1, 2026\n\nA\n\n---\n\n### Dropped\n\nLast updated: May 2, 2026\n\nX\n\n---\n\n' +
        '### Links\n\n#### [📄️Two](/docs/flutter/p1.md)\n\nCard.\n\n---\n\n### Two\n\nLast updated: May 3, 2026\n\nB\n'
    );
    expect(reconcilePages(dropped, index(['One', 'Two'])).map((p) => p.title)).toEqual([
      'One',
      'Dropped',
      'Links',
      'Two',
    ]);
  });

  it("keeps a dropped page that shares the next page's title apart, and links the page the index lists", () => {
    const pages = split(
      '### One\n\nLast updated: May 1, 2026\n\nA\n\n---\n\n### Two\n\nLast updated: May 2, 2026\n\nold\n\n---\n\n' +
        '### Two\n\nLast updated: May 3, 2026\n\nnew\n\n---\n\n### Three\n\nLast updated: May 4, 2026\n\nC\n'
    );
    const entries = index(['One', 'Two', 'Three']);
    const repaired = reconcilePages(pages, entries);
    attachUrls(repaired, entries);
    expect(repaired.map((p) => p.body.split('\n\n')[1])).toEqual(['A', 'old', 'new', 'C']);
    expect(repaired.map((p) => p.url === undefined)).toEqual([false, true, false, false]);
  });

  it('tells a page by its date, after a front-page banner too, or by its page cards', () => {
    expect(startsPage({ body: 'Last updated: May 1, 2026' })).toBe(true);
    expect(startsPage({ body: 'Intro\n\nLast updated: May 1, 2026' })).toBe(false);
    expect(startsPage({ body: '![](/docs/ios/assets/banner.png)\n\nLast updated: May 1, 2026' })).toBe(true);
    expect(startsPage({ body: 'Intro.\n\n#### [📄️Overview](/docs/cpp/guides/overview.md)\n\nAbout.' })).toBe(true);
    expect(
      startsPage({ body: 'Examples.\n\n[![Hello Map image](/docs/ios/assets/1.png)](/docs/ios/examples/hello-map)' })
    ).toBe(true);
    expect(startsPage({ body: 'See [Overview](/docs/cpp/guides/overview.md) and ![x](/docs/x.png).' })).toBe(false);
  });

  it('tells pages an index cut short from the last page\'s own headings by "Last updated:"', () => {
    const pages = split(
      '### One\n\nLast updated: May 1, 2026\n\nA\n\n---\n\n### Two\n\nLast updated: May 2, 2026\n\nB\n\n' +
        ['H1', 'H2', 'H3', 'H4'].map((h) => `---\n\n### ${h}\n\nown ${h}\n\n`).join('') +
        '---\n\n### P3\n\nLast updated: May 3, 2026\n\nC\n\n---\n\n### P3 detail\n\nD\n'
    );
    const repaired = reconcilePages(pages, index(['One', 'Two']));
    // Four headings of its own stay with Two; P3 opens like a page and is kept apart, with its own heading.
    expect(repaired.map((p) => p.title)).toEqual(['One', 'Two', 'P3']);
    expect(repaired[1]!.body).toContain('### H4\n\nown H4');
    expect(repaired[2]!.body).toBe('Last updated: May 3, 2026\n\nC\n\n---\n\n### P3 detail\n\nD');
  });

  it('keeps sections after the last listed page apart when there are too many to be its own headings', () => {
    const pages = split(
      '### One\n\nA\n\n---\n\n### Two\n\nB\n\n' +
        ['P3', 'P4', 'P5', 'P6'].map((t) => `---\n\n### ${t}\n\nbody of ${t}\n\n`).join('')
    );
    // The index stops after "Two" (cut short): Two stays itself, the rest are unlisted pages.
    const repaired = reconcilePages(pages, index(['One', 'Two']));
    expect(repaired.map((p) => p.title)).toEqual(['One', 'Two', 'P3', 'P4', 'P5', 'P6']);
    expect(repaired[1]!.body).toBe('B');
    // Up to three are the last page's own headings.
    const three = reconcilePages(
      split('### One\n\nA\n\n---\n\n### Two\n\nB\n\n---\n\n### H1\n\nC\n'),
      index(['One', 'Two'])
    );
    expect(three.map((p) => p.title)).toEqual(['One', 'Two']);
    expect(three[1]!.body).toBe('B\n\n---\n\n### H1\n\nC');
  });

  it('leaves a split alone when it starts with, or misses, pages the index lists in another order', () => {
    const extra = split('### Stray\n\nX\n\n---\n\n### One\n\nA\n\n---\n\n### Two\n\nB\n');
    expect(reconcilePages(extra, index(['One', 'Two']))).toBe(extra);
    const reordered = split('### Two\n\nB\n\n---\n\n### X\n\nX\n\n---\n\n### One\n\nA\n');
    expect(reconcilePages(reordered, index(['One', 'Two']))).toBe(reordered);
  });

  it('splits back out the pages an unclosed code fence swallowed, duplicates included', () => {
    const pages = split('### Intro\n\n```js\nopen();\n\n---\n\n### Two\n\nC\n\n---\n\n### Intro\n\nD\n');
    expect(pages.map((p) => p.title)).toEqual(['Intro']);
    const repaired = reconcilePages(pages, index(['Intro', 'Two', 'Intro', 'Missing (C++)']));
    expect(repaired.map((p) => p.title)).toEqual(['Intro', 'Two', 'Intro']);
    expect(repaired.map((p) => p.body)).toEqual(['```js\nopen();', 'C', 'D']);
    expect(pages).toHaveLength(1);
  });

  it('leaves an aligned split, and a source without an index, alone', () => {
    const pages = splitFullText(FLUTTER_FULL, 'flutter');
    expect(reconcilePages(pages, parseLlmsTxt(FLUTTER_LLMS, source))).toBe(pages);
    expect(reconcilePages(pages, [])).toBe(pages);
  });

  it('does not touch a split that merely disagrees with the index (a version skew)', () => {
    // Same count, one page renamed in the index: nothing is merged away.
    const pages = split('### One\n\nA\n\n---\n\n### Two\n\nB\n\n---\n\n### Three\n\nC\n');
    expect(reconcilePages(pages, index(['One', 'Two (renamed)', 'Three']))).toBe(pages);
    // More pages than the index, but more unknown titles than surplus: the export is newer.
    expect(reconcilePages(pages, index(['One', 'Four']))).toBe(pages);
    // Fewer pages than the index with the missing title nowhere inside: the index is newer.
    expect(reconcilePages(pages, index(['One', 'Two', 'Three', 'Five']))).toEqual(pages);
    // An index that knows none of the titles collapses nothing.
    const t0 = performance.now();
    expect(reconcilePages(pages, index(['X', 'Y']))).toBe(pages);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('is redone for a new index version and reused for the same one', async () => {
    resetCaches();
    seedFullTextSections('flutter', '## Docs\n\n### One\n\nA\n\n---\n\n### Detail\n\nB\n\n---\n\n### Two\n\nC\n');
    seedIndex('flutter', '- [One](/docs/flutter/one.md)\n- [Two](/docs/flutter/two.md)\n');
    const first = await loadFullTextSections(['flutter']);
    expect(first.sections.map((p) => p.title)).toEqual(['One', 'Two']);
    expect(first.sections.map((p) => p.url)).toEqual([
      `${DOCS.baseUrl}/docs/flutter/one.md`,
      `${DOCS.baseUrl}/docs/flutter/two.md`,
    ]);
    const again = await loadFullTextSections(['flutter']);
    expect(again.sections[0]).toBe(first.sections[0]);
    // The index now names all three: the original split is right after all.
    seedIndex(
      'flutter',
      '- [One](/docs/flutter/one.md)\n- [Detail](/docs/flutter/d.md)\n- [Two](/docs/flutter/two.md)\n'
    );
    const third = await loadFullTextSections(['flutter']);
    expect(third.sections.map((p) => p.title)).toEqual(['One', 'Detail', 'Two']);
    expect(third.sections[1]!.url).toBe(`${DOCS.baseUrl}/docs/flutter/d.md`);
  });
});

describe('splitFullText', () => {
  const pages = splitFullText(FLUTTER_FULL, 'flutter');

  it('splits one page per index entry, in order, despite headings inside page content', () => {
    expect(pages.map((p) => p.title)).toEqual(parseLlmsTxt(FLUTTER_LLMS, FLUTTER_SOURCE).map((e) => e.title));
  });

  it('keeps a page whole when it contains its own level-3 heading', () => {
    const calc = pages.find((p) => p.title === 'Calculate Route')!;
    expect(calc.body).toContain('### Advanced options');
    expect(calc.body).toContain('RoutePreferences');
  });

  it('ignores a ### line inside a fenced code block', () => {
    expect(pages.some((p) => p.title === 'not a heading')).toBe(false);
    expect(pages.find((p) => p.title === 'Calculate Route')!.body).toContain('### not a heading');
  });

  it('strips the trailing separator and heading anchor artifacts, and pre-lowercases', () => {
    for (const p of pages) expect(p.body.endsWith('---')).toBe(false);
    const calc = pages.find((p) => p.title === 'Calculate Route')!;
    expect(calc.body).toContain('#### Setup\n');
    expect(calc.body).not.toContain('Direct link');
    expect(calc.bodyLower).toBe(calc.body.toLowerCase());
    expect(calc.titleLower).toBe('calculate route');
  });

  it('handles CRLF input, an empty page, and a document with no pages', () => {
    const crlf = '# T\r\n\r\n## Docs\r\n\r\n### One\r\n\r\nbody\r\n\r\n---\r\n\r\n### Two\r\n\r\n---\r\n';
    const split = splitFullText(crlf, 'x');
    expect(split.map((p) => [p.title, p.body])).toEqual([
      ['One', 'body'],
      ['Two', ''],
    ]);
    expect(splitFullText('# Title\n\nJust prose, no pages.\n', 'x')).toEqual([]);
  });

  it('does not start a page on a ### that follows ordinary text', () => {
    const doc = '## Docs\n\n### First\n\nintro\n\n### Not a page\n\nmore\n';
    expect(splitFullText(doc, 'x').map((p) => p.title)).toEqual(['First']);
  });

  it('ends a fence with the list item it is in, so a closer indented too deep hides no page after it', () => {
    const doc =
      '## Docs\n\n### A\n\n- Step:\n\n  ```js\n  let a = 1;\n      ```\n\n---\n\n### B\n\nb\n\n---\n\n### C\n\nc\n';
    expect(splitFullText(doc, 'x').map((p) => [p.title, p.body])).toEqual([
      ['A', '- Step:\n\n  ```js\n  let a = 1;\n      ```'],
      ['B', 'b'],
      ['C', 'c'],
    ]);
  });
});

describe('attachUrls', () => {
  const entries = parseLlmsTxt(FLUTTER_LLMS, FLUTTER_SOURCE);

  it('joins by position when the files align', () => {
    const pages = splitFullText(FLUTTER_FULL, 'flutter');
    attachUrls(pages, entries);
    expect(pages.map((p) => p.path)).toEqual(entries.map((e) => e.path));
  });

  it('falls back to title matching, consuming duplicate titles in order', () => {
    const pages = splitFullText(
      '## Docs\n\n### Add Markers\n\na\n\n---\n\n### Unknown\n\nb\n\n---\n\n### Routes\n\nc\n',
      'flutter'
    );
    attachUrls(pages, entries);
    expect(pages.map((p) => p.url)).toEqual([entries[5]!.url, undefined, entries[6]!.url]);
  });
});

describe('searchFullText', () => {
  it('ranks the preferred platform higher and the preference word low', () => {
    const sections = [
      ...splitFullText(
        '## Docs\n\n### Cloud REST APIs\n\nThe cloud cloud cloud APIs: geocoding and more.\n',
        'cloud-rest-api'
      ),
      ...splitFullText('## Docs\n\n### Search\n\nGeocoding on the device, with geocoding examples.\n', 'android'),
      ...splitFullText(
        '## Docs\n\n### Reverse Geocode\n\nGeocoding: coordinates to addresses, geocoding.\n',
        'cloud-rest-api'
      ),
    ];
    expect(searchFullText(sections, 'cloud geocoding', 3).map((h) => h.title)[0]).toBe('Cloud REST APIs');
    const prefer = platformPreference('cloud geocoding');
    const ranked = searchFullText(sections, 'cloud geocoding', 3, undefined, undefined, prefer).map((h) => h.title);
    expect(ranked).toEqual(['Reverse Geocode', 'Cloud REST APIs', 'Search']);
  });

  const sections = splitFullText(FLUTTER_FULL, 'flutter');

  it('finds pages by whole-word match and returns an excerpt', () => {
    const hits = searchFullText(sections, 'MarkerCollection', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.title).toBe('Add Markers');
    expect(hits[0]!.excerpt).toContain('MarkerCollection');
  });

  it('does not match inside words but does match the plural', () => {
    expect(searchFullText(sections, 'point', 5)).toEqual([]); // "waypoints" contains it
    expect(searchFullText(sections, 'waypoint', 5).map((h) => h.title)).toContain('Calculate Route');
  });

  it('matches page words through the same stemming as the query, in any script', () => {
    const page = splitFullText(
      '## Docs\n\n### Caching\n\nThe cache sizes are initialized when routing starts; Straßen in Köln.\n',
      'flutter'
    );
    for (const query of ['cache qqqq', 'size qqqq', 'initialize qqqq', 'routes qqqq', 'caches', 'straße köln']) {
      expect(
        searchFullText(page, query, 5).map((h) => h.title),
        query
      ).toEqual(['Caching']);
    }
    expect(searchFullText(page, 'cachet qqqq', 5)).toEqual([]); // a different stem
  });

  it('never cuts an excerpt inside an emoji', () => {
    const body = `${'x '.repeat(200)}marker ${'\u{1F600}'.repeat(400)}`;
    const page = splitFullText(`## Docs\n\n### Smiles\n\n${body}\n`, 'flutter');
    const [hit] = searchFullText(page, 'marker', 1, 500);
    const excerpt = hit!.excerpt.replace(/^…|…$/g, '');
    const last = excerpt.charCodeAt(excerpt.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff, 'ends with a lone high surrogate').toBe(false);
    expect(excerpt.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
    const tail = `ab${'\u{1F600}'.repeat(300)} marker`; // the window start lands between two halves
    const page2 = splitFullText(`## Docs\n\n### Tail\n\n${tail}\n`, 'flutter');
    const [hit2] = searchFullText(page2, 'marker', 1, 102);
    const ex2 = hit2!.excerpt.replace(/^…|…$/g, '');
    expect(ex2.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
  });

  it('gives the phrase bonus when the page has the phrase in the plural', () => {
    const pages = splitFullText(
      '## Docs\n\n### A\n\nYou can add markers here.\n\n---\n\n### B\n\nMarkers you add.\n',
      'flutter'
    );
    const [first, second] = searchFullText(pages, 'add marker', 2);
    expect(first!.title).toBe('A');
    expect(first!.score).toBeGreaterThan(second!.score + 10);
  });

  it('breaks equal scores by the index ranking, then by the earliest mention, then by title', () => {
    const pages = splitFullText(
      '## Docs\n\n### Zeta\n\nThe api key.\n\n---\n\n### Alpha\n\nSome words, then the api key.\n\n' +
        '---\n\n### Beta\n\nMany more words first, and only then the api key.\n\n---\n\n### Gamma\n\n' +
        'Some words, then the api key.\n',
      'developer'
    ).map((page) => ({ ...page, path: `/docs/${page.title.toLowerCase()}.md` }));
    const titles = (rank?: Map<string, number>): string[] =>
      searchFullText(pages, 'api key', 4, undefined, rank).map((h) => h.title);
    expect(titles()).toEqual(['Zeta', 'Alpha', 'Gamma', 'Beta']);
    expect(titles(new Map([['/docs/beta.md', 0]]))).toEqual(['Beta', 'Zeta', 'Alpha', 'Gamma']);
  });

  it('boosts exact phrase matches in the body and in the title', () => {
    expect(searchFullText(sections, 'bike profile', 5)[0]!.title).toBe('Calculate Bike Route');
    expect(searchFullText(sections, 'draw route', 5)[0]!.title).toBe('Draw Route');
  });

  it('returns nothing for empty, symbol-only, or unmatched queries', () => {
    expect(searchFullText(sections, '', 5)).toEqual([]);
    expect(searchFullText(sections, '!!!', 5)).toEqual([]);
    expect(searchFullText(sections, 'quaternion', 5)).toEqual([]);
  });

  it('respects the limit and skips the phrase bonus for very short queries', () => {
    expect(searchFullText(sections, 'route', 2)).toHaveLength(2);
    expect(searchFullText(sections, 'map', 5).length).toBeGreaterThan(0);
  });

  it('carries the page URL once attached', () => {
    const pages = splitFullText(FLUTTER_FULL, 'flutter');
    attachUrls(pages, parseLlmsTxt(FLUTTER_LLMS, FLUTTER_SOURCE));
    const [hit] = searchFullText(pages, 'MarkerCollection', 1);
    expect(hit!.url).toBe('https://developer.magiclane.com/docs/flutter/examples/maps-3dscene/add-markers.md');
    expect(hit!.path).toBe('/docs/flutter/examples/maps-3dscene/add-markers.md');
  });

  it('breaks ties by title then path', () => {
    const twins = splitFullText(
      '## Docs\n\n### Same\n\nword\n\n---\n\n### Same\n\nword\n\n---\n\n### Same\n\nword\n\n---\n\n### Also\n\nword\n',
      'x'
    );
    twins[0]!.path = '/b';
    twins[1]!.path = '/a';
    expect(searchFullText(twins, 'word', 5).map((h) => [h.title, h.path])).toEqual([
      ['Also', undefined],
      ['Same', undefined],
      ['Same', '/a'],
      ['Same', '/b'],
    ]);
  });

  it('anchors the excerpt at the start for title-only matches', () => {
    const [hit] = searchFullText(sections, 'scene', 1, 20);
    expect(hit!.title).toBe('Maps & 3D Scene');
    expect(hit!.excerpt.startsWith('…')).toBe(false);
  });

  it('elides on the left when the match sits deep in the body, and on the right when more follows', () => {
    const long = splitFullText(`## Docs\n\n### Long\n\n${'filler '.repeat(200)}needle ${'tail '.repeat(200)}\n`, 'x');
    const [hit] = searchFullText(long, 'needle', 1, 100);
    expect(hit!.excerpt.startsWith('…')).toBe(true);
    expect(hit!.excerpt.endsWith('…')).toBe(true);
    expect(hit!.excerpt).toContain('needle');
  });
});

describe('loadFullTextSections', () => {
  let restore = (): void => {};

  beforeEach(() => {
    seedFixtures();
  });

  afterEach(() => {
    restore();
    restore = () => {};
    vi.useRealTimers();
  });

  it('loads pages for every source, each joined to its index URL', async () => {
    const { sections, failed } = await loadFullTextSections();
    expect(failed).toEqual([]);
    expect(new Set(sections.map((s) => s.source))).toEqual(new Set(DOCS.sources.map((s) => s.id)));
    expect(sections.every((s) => s.url !== undefined)).toBe(true);
  });

  it('scopes loading to one source and ignores unknown ids', async () => {
    const { sections } = await loadFullTextSections([FLUTTER_SOURCE.id]);
    expect(sections.every((s) => s.source === FLUTTER_SOURCE.id)).toBe(true);
    expect((await loadFullTextSections(['nope'])).sections).toEqual([]);
  });

  it('leaves URLs unset when the index for a source cannot be loaded', async () => {
    resetCaches();
    seedFullTextSections(DEVELOPER_SOURCE.id, '## Docs\n\n### Solo\n\nbody\n');
    ({ restore } = stubFetch({})); // the index request answers 404
    const { sections, failed } = await loadFullTextSections([DEVELOPER_SOURCE.id]);
    expect(failed).toEqual([]);
    expect(sections.map((s) => [s.title, s.url])).toEqual([['Solo', undefined]]);
  });

  it('peeks at the pages in memory: none before a load, joined to the index after one', async () => {
    resetCaches();
    expect(peekFullTextSections(FLUTTER_SOURCE.id)).toBeUndefined();
    seedFullTextSections(FLUTTER_SOURCE.id, '## Docs\n\n### Solo\n\nbody\n');
    expect(peekFullTextSections(FLUTTER_SOURCE.id)?.map((p) => [p.title, p.path])).toEqual([['Solo', undefined]]);
    seedIndex(FLUTTER_SOURCE.id, '- [Solo](/docs/flutter/solo.md)');
    await loadFullTextSections([FLUTTER_SOURCE.id]);
    expect(peekFullTextSections(FLUTTER_SOURCE.id)?.map((p) => p.path)).toEqual(['/docs/flutter/solo.md']);
  });

  it('re-links pages when a new index moves them, though the page contents did not change', async () => {
    resetCaches();
    seedFullTextSections(FLUTTER_SOURCE.id, '## Docs\n\n### Solo\n\nbody\n');
    seedIndex(FLUTTER_SOURCE.id, '- [Solo](/docs/flutter/old/solo.md)');
    expect((await loadFullTextSections([FLUTTER_SOURCE.id])).sections[0]!.url).toBe(
      'https://developer.magiclane.com/docs/flutter/old/solo.md'
    );
    seedIndex(FLUTTER_SOURCE.id, '- [Solo](/docs/flutter/new/solo.md)');
    expect((await loadFullTextSections([FLUTTER_SOURCE.id])).sections[0]!.url).toBe(
      'https://developer.magiclane.com/docs/flutter/new/solo.md'
    );
    // Renamed and moved: the page contents still say "Solo", the index no
    // longer does — no link rather than the old one.
    seedIndex(FLUTTER_SOURCE.id, '- [Alone](/docs/flutter/new/alone.md)\n- [Other](/docs/flutter/other.md)');
    const [solo] = (await loadFullTextSections([FLUTTER_SOURCE.id])).sections;
    expect([solo!.url, solo!.path]).toEqual([undefined, undefined]);
  });

  it('names a source whose full text cannot be fetched', async () => {
    resetCaches();
    seedIndex(FLUTTER_SOURCE.id, FLUTTER_LLMS);
    ({ restore } = stubFetch({}));
    const { sections, failed } = await loadFullTextSections([FLUTTER_SOURCE.id]);
    expect(sections).toEqual([]);
    expect(failed).toEqual([
      { source: 'flutter', part: 'full-text', reason: expect.stringContaining('HTTP 404'), kind: 'file' },
    ]);
  });

  it('keeps the pages of a source whose index failed, reporting them as unlinked', async () => {
    resetCaches();
    seedFullTextSections(FLUTTER_SOURCE.id, FLUTTER_FULL);
    ({ restore } = stubFetch({}));
    const { sections, failed, unlinked } = await loadFullTextSections([FLUTTER_SOURCE.id]);
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.every((s) => s.url === undefined)).toBe(true);
    expect(failed).toEqual([]);
    expect(unlinked).toEqual([
      { source: 'flutter', part: 'index', reason: expect.stringContaining('HTTP 404'), kind: 'file' },
    ]);
  });

  it('reports a full text that yields no pages as failed, not as a source without pages', async () => {
    for (const content of ['', '<p>moved</p>']) {
      resetCaches();
      seedIndex(FLUTTER_SOURCE.id, FLUTTER_LLMS);
      seedFullTextSections(FLUTTER_SOURCE.id, content);
      const { sections, failed } = await loadFullTextSections([FLUTTER_SOURCE.id]);
      expect(sections).toEqual([]);
      expect(failed).toEqual([{ source: 'flutter', part: 'full-text', reason: EMPTY_FULL_TEXT_REASON, kind: 'file' }]);
    }
  });

  it('classifies a host that fails or times out as unreachable', async () => {
    resetCaches();
    seedIndex(FLUTTER_SOURCE.id, FLUTTER_LLMS);
    ({ restore } = stubFetch({
      'https://developer.magiclane.com/docs/flutter/llms-full.txt': () => Promise.reject(new TypeError('fetch failed')),
    }));
    const { failed } = await loadFullTextSections([FLUTTER_SOURCE.id]);
    expect(failed).toEqual([{ source: 'flutter', part: 'full-text', reason: 'fetch failed', kind: 'unreachable' }]);
  });

  it('downloads once for concurrent callers and keeps the pages across the TTL via 304', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    resetCaches();
    seedIndex(FLUTTER_SOURCE.id, FLUTTER_LLMS);
    let fullTextRequests = 0;
    const stub = stubFetch({
      [FLUTTER_SOURCE.fullTextUrl as string]: () => {
        fullTextRequests++;
        return fullTextRequests === 1
          ? new Response(FLUTTER_FULL, { status: 200, headers: { etag: '"a"' } })
          : new Response(null, { status: 304 });
      },
    });
    restore = stub.restore;
    const [a, b] = await Promise.all([
      loadFullTextSections([FLUTTER_SOURCE.id]),
      loadFullTextSections([FLUTTER_SOURCE.id]),
    ]);
    expect(fullTextRequests).toBe(1);
    expect(b.sections).toEqual(a.sections);
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    const c = await loadFullTextSections([FLUTTER_SOURCE.id]);
    expect(fullTextRequests).toBe(2);
    expect(c.sections.map((s) => s.title)).toEqual(a.sections.map((s) => s.title));
  });

  it('keeps serving stale pages when a refresh fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    resetCaches();
    seedIndex(FLUTTER_SOURCE.id, FLUTTER_LLMS);
    const stub = stubFetch({ [FLUTTER_SOURCE.fullTextUrl as string]: FLUTTER_FULL });
    const first = await loadFullTextSections([FLUTTER_SOURCE.id]);
    stub.restore();
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    ({ restore } = stubFetch({ [FLUTTER_SOURCE.fullTextUrl as string]: 500 }));
    const second = await loadFullTextSections([FLUTTER_SOURCE.id]);
    expect(second.failed).toEqual([]);
    expect(second.sections.length).toBe(first.sections.length);
  });

  it('reports memo statistics and clears them', async () => {
    await loadFullTextSections();
    const stats = fullTextStats();
    expect(stats.sources).toBe(DOCS.sources.length);
    expect(stats.sections).toBeGreaterThan(7);
    clearFullTextCache();
    expect(fullTextStats()).toEqual({ sources: 0, sections: 0 });
  });
});
