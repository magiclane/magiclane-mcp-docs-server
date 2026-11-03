/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectClient, isError, resetCaches, seedFixtures, seedPage, stubFetch, textOf } from '../helpers.js';
import { seedIndex } from '../../src/docs/docs-index.js';
import { loadFullTextSections, seedFullTextSections } from '../../src/docs/full-text.js';
import type { TestClient } from '../helpers.js';
import { CACHE, LIMITS } from '../../src/config/constants.js';
import { fenceFor } from '../../src/tools/get-code-examples-tool.js';

const EXAMPLE_PAGE = `# Add Markers

Prose before.

\`\`\`dart
final marker = Marker(coordinates: coords);
\`\`\`

## Install

\`\`\`bash
# add the package
flutter pub add gem_kit
\`\`\`
`;

const PAGE_URL = 'https://developer.magiclane.com/docs/flutter/examples/add-markers'; // the page as linked: the web page, not its .md

describe('fenceFor', () => {
  it('fences a block with one backtick more than the longest fence inside it, three at least', () => {
    expect(fenceFor('let a = 1')).toBe('```');
    expect(fenceFor('# Title\n```dart\nx\n```')).toBe('````');
    expect(fenceFor('  `````\ninline ``````` here')).toBe('``````');
    // A backtick in the info string is not allowed on a backtick fence: a tilde fence, longer than any inside.
    expect(fenceFor('x', 'js`x')).toBe('~~~');
    expect(fenceFor('~~~~\nx', 'js`x')).toBe('~~~~~');
  });
});

describe('get_code_examples', () => {
  let t: TestClient;
  let restore = (): void => {};

  beforeEach(async () => {
    seedFixtures();
    seedPage('/docs/flutter/examples/add-markers.md', EXAMPLE_PAGE);
    t = await connectClient();
  });

  afterEach(async () => {
    restore();
    restore = () => {};
    await t.close();
  });

  it('returns only the code blocks of a page, with the nearest real heading', async () => {
    const text = textOf(
      await t.client.callTool({ name: 'get_code_examples', arguments: { url: '/docs/flutter/examples/add-markers' } })
    );
    expect(text).toContain(`# Code examples from ${PAGE_URL}`);
    expect(text).toContain('2 block(s)');
    expect(text).toContain('## Example 1 (dart) — Add Markers\n\n```dart\nfinal marker');
    expect(text).toContain('## Example 2 (bash) — Install\n\n```bash\n# add the package');
    expect(text).not.toContain('Prose before');
  });

  it('labels blocks with their caption, and filters by it', async () => {
    seedPage(
      '/docs/cloud-rest-api/guides/x.md',
      '## Endpoints\n\n### 1. Create Thing\n\n#### Example:\n\n* **Request Body:**\n\n```json\n{"a":1}\n```\n\n' +
        '* **Response Body:** (error code `200`)\n\n```json\n{"id":1}\n```\n\nSome prose about it.\n\n```json\n{"b":2}\n```\n'
    );
    const all = textOf(
      await t.client.callTool({ name: 'get_code_examples', arguments: { url: '/docs/cloud-rest-api/guides/x' } })
    );
    expect(all).toContain('## Example 1 (json) — 1. Create Thing › Example · Request Body\n');
    expect(all).toContain('## Example 2 (json) — 1. Create Thing › Example · Response Body (error code 200)\n');
    expect(all).toContain('## Example 3 (json) — 1. Create Thing › Example\n'); // prose is not a caption
    const requests = textOf(
      await t.client.callTool({
        name: 'get_code_examples',
        arguments: { url: '/docs/cloud-rest-api/guides/x', caption: 'request' },
      })
    );
    expect(requests).toContain('1 block(s)');
    expect(requests).toContain('{"a":1}');
    expect(requests).not.toContain('{"id":1}');
    const none = textOf(
      await t.client.callTool({
        name: 'get_code_examples',
        arguments: { url: '/docs/cloud-rest-api/guides/x', language: 'json', caption: 'curl' },
      })
    );
    expect(none).toContain('No code blocks matching language "json" and caption "curl"');
    // A blank caption filter is no filter: the unlabelled block stays too.
    const blank = textOf(
      await t.client.callTool({
        name: 'get_code_examples',
        arguments: { url: '/docs/cloud-rest-api/guides/x', caption: '   ' },
      })
    );
    expect(blank).toContain('3 block(s)');
  });

  it('filters by language, honouring aliases', async () => {
    const text = textOf(
      await t.client.callTool({
        name: 'get_code_examples',
        arguments: { url: '/docs/flutter/examples/add-markers', language: 'shell' },
      })
    );
    expect(text).toContain('1 block(s)');
    expect(text).toContain('flutter pub add gem_kit');
    expect(text).not.toContain('Marker(');
  });

  it('explains when the language filter matches nothing, and when the page has no code', async () => {
    const none = textOf(
      await t.client.callTool({
        name: 'get_code_examples',
        arguments: { url: '/docs/flutter/examples/add-markers', language: 'swift' },
      })
    );
    expect(none).toContain(
      `No code blocks matching language "swift" on ${PAGE_URL} (2 block(s) in all). Its blocks are bash (1), dart (1).`
    );
    expect(none).toContain('Try without the filter, or read the full page with read_doc.');
    // Filters with line breaks are quoted on one line: they cannot add a heading of their own to the reply.
    const folded = textOf(
      await t.client.callTool({
        name: 'get_code_examples',
        arguments: { url: '/docs/flutter/examples/add-markers', language: 'zz\n\n# Fake heading', caption: 'a\nb' },
      })
    );
    expect(folded).toContain('No code blocks matching language "zz # Fake heading" and caption "a b" on ');
    expect(folded).not.toContain('\n# Fake heading');
    const prose = textOf(
      await t.client.callTool({ name: 'get_code_examples', arguments: { url: '/docs/guides/get-started' } })
    );
    expect(prose).toContain('No code blocks found on https://developer.magiclane.com/docs/guides/get-started');
    expect(prose).toContain('Read the full page with read_doc.');
  });

  it('points at the pages below an overview page that hold the code, with their block counts', async () => {
    const OVERVIEW = '/docs/flutter/examples/routing-navigation';
    seedPage(`${OVERVIEW}.md`, '# Routing & Navigation\n\nExamples, no code here.');
    const all = textOf(await t.client.callTool({ name: 'get_code_examples', arguments: { url: OVERVIEW } }));
    expect(all).toContain(
      'No code blocks found on https://developer.magiclane.com/docs/flutter/examples/routing-navigation.\n\n' +
        'Pages below it with code blocks:\n' +
        '- Calculate Route — https://developer.magiclane.com/docs/flutter/examples/routing-navigation/calculate-route (2 block(s))'
    );
    expect(all).not.toContain('Draw Route'); // below it, but without code
    const shell = textOf(
      await t.client.callTool({ name: 'get_code_examples', arguments: { url: OVERVIEW, language: 'shell' } })
    );
    expect(shell).toContain('(0 block(s) in all).\n\nPages below it with shell code blocks:\n- Calculate Route — ');
    expect(shell).toContain('calculate-route (1 shell block(s))');
    const swift = textOf(
      await t.client.callTool({ name: 'get_code_examples', arguments: { url: OVERVIEW, language: 'swift' } })
    );
    expect(swift).not.toContain('Pages below it');
  });

  it('points at related pages when the page has none below it, and at nothing when none hold code', async () => {
    // "Routes" is a leaf: the pages its title finds are the route examples.
    seedPage('/docs/flutter/guides/core/routes.md', '# Routes\n\nA route is a path.');
    const related = textOf(
      await t.client.callTool({ name: 'get_code_examples', arguments: { url: '/docs/flutter/guides/core/routes' } })
    );
    expect(related).toContain('Related pages with code blocks:\n- Calculate Route — ');
    // Unlisted and untitled: nothing to look for.
    seedPage('/docs/guides/nothing.md', 'Plain text only.');
    const nothing = textOf(
      await t.client.callTool({ name: 'get_code_examples', arguments: { url: '/docs/guides/nothing' } })
    );
    expect(nothing).toBe(
      'No code blocks found on https://developer.magiclane.com/docs/guides/nothing.\n\nRead the full page with read_doc.'
    );
  });

  it('lists the pages below unchecked when their contents cannot be loaded, and caps the list', async () => {
    resetCaches();
    const index =
      '- [Overview](/docs/android/guides/overview.md): Start here.\n' +
      '- [Part 0](/docs/android/guides/overview/part-0.md): Listed, but missing from the page contents.\n' +
      [1, 2, 3, 4, 5, 6, 7]
        .map((i) => `- [Part ${i}](/docs/android/guides/overview/part-${i}.md): Part ${i}.\n`)
        .join('');
    seedIndex('android', index);
    seedPage('/docs/android/guides/overview.md', '# Overview\n\nNo code.');
    ({ restore } = stubFetch({}));
    const unchecked = textOf(
      await t.client.callTool({ name: 'get_code_examples', arguments: { url: '/docs/android/guides/overview' } })
    );
    expect(unchecked).toContain(
      'Pages below it, not checked for code (the page contents could not be loaded):\n' +
        '- Part 0 — https://developer.magiclane.com/docs/android/guides/overview/part-0\n' +
        '- Part 1 — https://developer.magiclane.com/docs/android/guides/overview/part-1\n'
    );
    expect(unchecked).toContain('- Part 4 — ');
    expect(unchecked).not.toContain('- Part 5 — ');

    seedFullTextSections(
      'android',
      '## Docs\n\n### Orphan\n\nNot in the index.\n\n---\n\n' +
        [1, 2, 3, 4, 5, 6, 7].map((i) => `### Part ${i}\n\n\`\`\`kotlin\nval x = ${i}\n\`\`\`\n\n---\n\n`).join('')
    );
    const capped = textOf(
      await t.client.callTool({ name: 'get_code_examples', arguments: { url: '/docs/android/guides/overview' } })
    );
    expect(capped).toContain('Pages below it with code blocks (the first 5):\n- Part 1 — '); // Part 0: no contents
    expect(capped).toContain('part-5 (1 block(s))');
    expect(capped).not.toContain('Part 6');
  });

  it('counts only the blocks that match the caption too, and says "the first 5" only when there are more', async () => {
    resetCaches();
    seedIndex(
      'android',
      '- [Overview](/docs/android/guides/overview.md): Start here.\n' +
        [1, 2, 3, 4, 5].map((i) => `- [Part ${i}](/docs/android/guides/overview/part-${i}.md): Part ${i}.\n`).join('')
    );
    seedPage('/docs/android/guides/overview.md', '# Overview\n\nNo code.');
    seedFullTextSections(
      'android',
      '## Docs\n\n### Overview\n\nNo code.\n\n---\n\n' +
        [1, 2, 3, 4, 5]
          .map(
            (i) =>
              `### Part ${i}\n\nRequest Body:\n\n\`\`\`json\n{"a": ${i}}\n\`\`\`\n\nResponse:\n\n\`\`\`json\n{}\n\`\`\`\n\n---\n\n`
          )
          .join('')
    );
    const all = textOf(
      await t.client.callTool({ name: 'get_code_examples', arguments: { url: '/docs/android/guides/overview' } })
    );
    // Exactly five pages hold code: all of them are listed, and nothing says "the first".
    expect(all).toContain('Pages below it with code blocks:\n- Part 1 — ');
    expect(all).toContain('part-5 (2 block(s))');
    const captioned = textOf(
      await t.client.callTool({
        name: 'get_code_examples',
        arguments: { url: '/docs/android/guides/overview', language: 'json', caption: 'request' },
      })
    );
    expect(captioned).toContain('Pages below it with json code blocks captioned "request":\n- Part 1 — ');
    expect(captioned).toContain('part-1 (1 json block(s))');
    const none = textOf(
      await t.client.callTool({
        name: 'get_code_examples',
        arguments: { url: '/docs/android/guides/overview', caption: 'zzz' },
      })
    );
    expect(none).not.toContain('Pages below it');
  });

  it('says the nearby pages could not be checked when no index arrives within 2 s', async () => {
    resetCaches();
    seedPage('/docs/android/guides/overview.md', '# Overview\n\nNo code.');
    ({ restore } = stubFetch({
      'https://developer.magiclane.com/docs/android/llms.txt': () => new Promise<Response>(() => {}),
    }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = t.client.callTool({
        name: 'get_code_examples',
        arguments: { url: '/docs/android/guides/overview' },
      });
      await vi.advanceTimersByTimeAsync(2_001);
      expect(textOf(await pending)).toBe(
        'No code blocks found on https://developer.magiclane.com/docs/android/guides/overview.\n\n' +
          'Which nearby pages hold code could not be checked: the android index could not be loaded within 2 s (the site ' +
          'is slow or unreachable). search_docs finds related pages.\n\nRead the full page with read_doc.'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the nearby pages could not be checked when the index fails at once', async () => {
    resetCaches();
    seedPage('/docs/android/guides/overview.md', '# Overview\n\nNo code.');
    ({ restore } = stubFetch({})); // the index answers 404 at once
    const text = textOf(
      await t.client.callTool({ name: 'get_code_examples', arguments: { url: '/docs/android/guides/overview' } })
    );
    expect(text).toContain(
      'Which nearby pages hold code could not be checked: the android index could not be loaded ('
    );
    expect(text).toContain('404');
    // It came back at once: not blamed on a slow site.
    expect(text).not.toContain('slow or unreachable');
  });

  it('points a page whose most specific word no other page has to the pages sharing its other words', async () => {
    resetCaches();
    seedIndex(
      'cpp',
      '## Examples\n\n' +
        '- [Switch Map Perspective](/docs/cpp/examples/switch-map-perspective.md): Toggle the view angle.\n' +
        '- [Map Perspective](/docs/cpp/examples/map-perspective.md): Tilt the map.\n' +
        '- [Adjust the map view](/docs/cpp/guides/adjust-map.md): Move the map.\n'
    );
    seedFullTextSections(
      'cpp',
      '# Switch Map Perspective\n\nNo code here.\n\n# Map Perspective\n\n```cpp\nmap.setTilt(30);\n```\n\n' +
        '# Adjust the map view\n\n```cpp\nmap.center();\n```\n'
    );
    seedPage('/docs/cpp/examples/switch-map-perspective.md', '# Switch Map Perspective\n\nNo code here.');
    const text = textOf(
      await t.client.callTool({
        name: 'get_code_examples',
        arguments: { url: '/docs/cpp/examples/switch-map-perspective' },
      })
    );
    expect(text).toContain('Map Perspective — https://developer.magiclane.com/docs/cpp/examples/map-perspective');
    expect(text).not.toContain('Adjust the map view');
  });

  it('points from the copies in memory when their refresh hangs', async () => {
    resetCaches();
    const OVERVIEW = 'https://developer.magiclane.com/docs/android/guides/overview.md';
    seedIndex(
      'android',
      '- [Overview](/docs/android/guides/overview.md): Start here.\n' +
        '- [Part 1](/docs/android/guides/overview/part-1.md): Part 1.\n'
    );
    seedFullTextSections(
      'android',
      '## Docs\n\n### Overview\n\nNo code.\n\n---\n\n### Part 1\n\n```kotlin\nval x = 1\n```\n'
    );
    await loadFullTextSections(['android']); // joined to the index, as a search would have
    const hang = (): Promise<Response> => new Promise<Response>(() => {});
    ({ restore } = stubFetch({
      [OVERVIEW]: '# Overview\n\nNo code.',
      'https://developer.magiclane.com/docs/android/llms.txt': hang,
      'https://developer.magiclane.com/docs/android/llms-full.txt': hang,
    }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      vi.setSystemTime(Date.now() + CACHE.ttlMs + 1); // both copies are due a refresh, which hangs
      const pending = t.client.callTool({ name: 'get_code_examples', arguments: { url: OVERVIEW } });
      await vi.advanceTimersByTimeAsync(2_001);
      expect(textOf(await pending)).toContain(
        'Pages below it with code blocks:\n- Part 1 — https://developer.magiclane.com/docs/android/guides/overview/part-1 (1 block(s))'
      );
      // An index in memory without page contents: the pages below are listed unchecked.
      resetCaches();
      seedIndex(
        'android',
        '- [Overview](/docs/android/guides/overview.md): Start here.\n' +
          '- [Part 1](/docs/android/guides/overview/part-1.md): Part 1.\n'
      );
      vi.setSystemTime(Date.now() + CACHE.ttlMs + 1);
      const unchecked = t.client.callTool({ name: 'get_code_examples', arguments: { url: OVERVIEW } });
      await vi.advanceTimersByTimeAsync(2_001);
      expect(textOf(await unchecked)).toContain(
        'Pages below it, not checked for code (the page contents could not be loaded)'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('points at pages that mention every word of the title when none is about its most specific one', async () => {
    resetCaches();
    seedIndex(
      'cpp',
      '- [Center Map](/docs/cpp/examples/center-map.md): Center the map on coordinates.\n' +
        '- [Adjust the map view](/docs/cpp/guides/adjust-map.md): Center, zoom and tilt the map.\n' +
        '- [Map Styles](/docs/cpp/guides/styles.md): Style the map.\n' +
        '- [Map View](/docs/cpp/guides/view.md): Show a map view.\n' +
        '- [Pin Placement](/docs/cpp/guides/pins.md): Center pins on the map.\n'
    );
    seedFullTextSections(
      'cpp',
      '## Docs\n\n### Center Map\n\nNo code.\n\n---\n\n### Adjust the map view\n\n```cpp\nmap.center();\n```\n\n' +
        '---\n\n### Map Styles\n\nNo code.\n\n---\n\n### Map View\n\nNo code.\n\n---\n\n' +
        '### Pin Placement\n\n```cpp\npins();\n```\n'
    );
    seedPage('/docs/cpp/examples/center-map.md', '# Center Map\n\nNo code.');
    const text = textOf(
      await t.client.callTool({ name: 'get_code_examples', arguments: { url: '/docs/cpp/examples/center-map' } })
    );
    // No other title says "center": the pages that mention it and the map, and share "map" in their title.
    expect(text).toContain('Related pages with code blocks:\n- Adjust the map view — ');
    expect(text).not.toContain('Pin Placement'); // mentions both, but its title shares no word
  });

  it('points only at the pages about the most specific word when they hold code, not at every page that mentions it', async () => {
    resetCaches();
    seedIndex(
      'cpp',
      '## Examples\n\n' +
        '- [Calculate Route](/docs/cpp/examples/calculate-route.md): Calculate a route and render it.\n' +
        '- [Calculate Route Multi View](/docs/cpp/examples/calculate-route-multi-view.md): Calculate 4 routes in 4 views.\n' +
        '- [Reoptimize Route](/docs/cpp/examples/reoptimize-route.md): Calculate the route of an optimization again.\n' +
        '- [Routing](/docs/cpp/guides/routing.md): Routes from A to B.\n'
    );
    seedFullTextSections(
      'cpp',
      '## Docs\n\n### Calculate Route\n\nNo code here.\n\n---\n\n### Calculate Route Multi View\n\n```cpp\nroutes(4);\n```\n\n' +
        '---\n\n### Reoptimize Route\n\n```cpp\nroute(2);\n```\n\n---\n\n### Routing\n\n```cpp\nroute();\n```\n'
    );
    seedPage('/docs/cpp/examples/calculate-route.md', '# Calculate Route\n\nNo code here.');
    const text = textOf(
      await t.client.callTool({ name: 'get_code_examples', arguments: { url: '/docs/cpp/examples/calculate-route' } })
    );
    // "Reoptimize Route" mentions calculating a route and shares "Route", but a
    // page about calculating holds code, so the weaker relation is not pointed at.
    expect(text).toContain('Related pages with code blocks:\n- Calculate Route Multi View — ');
    expect(text).not.toContain('Reoptimize Route');
    expect(text).not.toContain('- Routing');
  });

  it('points an example whose related examples hold no code either at the guides on its topic, in its area', async () => {
    resetCaches();
    seedIndex(
      'cpp',
      '- [Places & Search](/docs/cpp/examples/places-search.md): Search examples.\n' +
        '- [Free Text Search](/docs/cpp/examples/places-search/free-text-search.md): Search places by free text.\n' +
        '- [Multi Search](/docs/cpp/examples/places-search/multi-search.md): Run several text searches.\n' +
        '- [Search](/docs/cpp/guides/search.md): Search guides.\n' +
        '- [Getting started with Search](/docs/cpp/guides/search/get-started.md): Search for places by text.\n' +
        '- [Alarms](/docs/cpp/guides/alarms.md): Alarms.\n' +
        '- [Text alarms](/docs/cpp/guides/alarms/text-alarms.md): Alarms that say free text.\n'
    );
    seedFullTextSections(
      'cpp',
      '## Docs\n\n### Places & Search\n\nNo code.\n\n---\n\n### Free Text Search\n\nNo code.\n\n---\n\n### Multi Search\n\n' +
        'No code.\n\n---\n\n### Search\n\nNo code.\n\n---\n\n### Getting started with Search\n\n```cpp\nsearch();\n```\n\n' +
        '---\n\n### Alarms\n\nNo code.\n\n---\n\n### Text alarms\n\n```cpp\nalarm();\n```\n'
    );
    seedPage('/docs/cpp/examples/places-search/free-text-search.md', '# Free Text Search\n\nNo code.');
    const text = textOf(
      await t.client.callTool({
        name: 'get_code_examples',
        arguments: { url: '/docs/cpp/examples/places-search/free-text-search' },
      })
    );
    expect(text).toContain('Guides on its topic with code blocks:\n- Getting started with Search — ');
    // It says "free text" too, but it is no guide of the example's area (Places & Search).
    expect(text).not.toContain('Text alarms');
  });

  it('pages through many blocks within a character budget', async () => {
    const blocks = Array.from({ length: 6 }, (_, i) => `\`\`\`js\nconst block${i} = ${'0'.repeat(400)};\n\`\`\``).join(
      '\n\n'
    );
    seedPage('/docs/many.md', blocks);
    const first = textOf(
      await t.client.callTool({ name: 'get_code_examples', arguments: { url: '/docs/many', maxChars: 1_000 } })
    );
    expect(first).toContain('Blocks 1–2 of 6; 4 more — call again with offset: 2.');
    expect(first).toContain('block1');
    expect(first).not.toContain('block2');
    const last = textOf(
      await t.client.callTool({ name: 'get_code_examples', arguments: { url: '/docs/many', offset: 5 } })
    );
    expect(last).toContain('Blocks 6–6 of 6 (last).');
    const single = textOf(
      await t.client.callTool({ name: 'get_code_examples', arguments: { url: '/docs/many', maxChars: 1 } })
    );
    expect(single).toContain('Blocks 1–1 of 6; 5 more'); // at least one block, even over budget
    const beyond = await t.client.callTool({ name: 'get_code_examples', arguments: { url: '/docs/many', offset: 6 } });
    expect(isError(beyond)).toBe(true);
    expect(textOf(beyond)).toContain('offset 6 is beyond the last code block (6');
  });

  it('returns a block longer than the budget in parts, each within it', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `final line${i} = ${'1'.repeat(40)};`).join('\n');
    seedPage('/docs/huge.md', `## Setup\n\n\`\`\`dart\n${lines}\n\`\`\`\n\n\`\`\`dart\nsmall();\n\`\`\``);
    const first = textOf(
      await t.client.callTool({ name: 'get_code_examples', arguments: { url: '/docs/huge', maxChars: 5_000 } })
    );
    expect(first).toContain('## Example 1 (dart, part 1 of 4) — Setup');
    expect(first).toContain('(2 blocks; those longer than the budget are split into parts, and offsets count parts)');
    expect(first).toContain('Parts 1–1 of 5; 4 more — call again with offset: 1.');
    expect(first.length).toBeLessThan(5_600);
    const last = textOf(
      await t.client.callTool({
        name: 'get_code_examples',
        arguments: { url: '/docs/huge', offset: 4, maxChars: 5_000 },
      })
    );
    expect(last).toContain('## Example 2 (dart) — Setup');
    // The default budget fits the whole block.
    const whole = textOf(await t.client.callTool({ name: 'get_code_examples', arguments: { url: '/docs/huge' } }));
    expect(whole).toContain('## Example 1 (dart) — Setup');
    expect(whole).not.toContain('split into parts');
  });

  it('marks a part that ends in the middle of a line', async () => {
    seedPage('/docs/longline.md', `\`\`\`json\n${'x'.repeat(2_500)}\n\`\`\``);
    const text = textOf(
      await t.client.callTool({ name: 'get_code_examples', arguments: { url: '/docs/longline', maxChars: 2_200 } })
    );
    expect(text).toContain('## Example 1 (json, part 1 of 2, ends mid-line)');
  });

  it('caps maxChars at the per-page maximum', async () => {
    const result = await t.client.callTool({
      name: 'get_code_examples',
      arguments: { url: '/docs/huge', maxChars: LIMITS.maxDocumentChars + 1 },
    });
    expect(isError(result)).toBe(true);
  });

  it('reports fetch failures and rejects non-magiclane URLs as errors', async () => {
    ({ restore } = stubFetch({}));
    const missing = await t.client.callTool({ name: 'get_code_examples', arguments: { url: '/docs/missing' } });
    expect(isError(missing)).toBe(true);
    expect(textOf(missing)).toContain('Failed to fetch document "/docs/missing": HTTP 404');
    const foreign = await t.client.callTool({
      name: 'get_code_examples',
      arguments: { url: 'https://docs.example/x' },
    });
    expect(isError(foreign)).toBe(true);
    expect(textOf(foreign)).toContain('Only https://developer.magiclane.com');
  });

  it('rejects an over-long language filter with a validation error', async () => {
    const result = await t.client.callTool({
      name: 'get_code_examples',
      arguments: { url: '/docs/flutter/examples/add-markers', language: 'x'.repeat(LIMITS.maxFilterChars + 1) },
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain(`at most ${LIMITS.maxFilterChars} character`);
  });
});
