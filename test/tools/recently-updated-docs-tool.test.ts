/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectClient,
  FLUTTER_LLMS,
  FLUTTER_SOURCE,
  isError,
  resetCaches,
  seedFixtures,
  stubFetch,
  textOf,
} from '../helpers.js';
import type { TestClient } from '../helpers.js';
import { seedFullTextSections } from '../../src/docs/full-text.js';
import { seedIndex } from '../../src/docs/docs-index.js';

function isoDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function siteDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Dated pages in index order for the flutter fixture (Routing & Navigation, Calculate Route, ...). */
const DATED_FLUTTER = `# Docs

## Docs

### Routing & Navigation

Last updated:

<!-- -->

${siteDate(3)}

<!-- -->

Body.

---

### Calculate Route

Last updated: ${siteDate(200)}

Body.

---

### Calculate Bike Route

Body without a marker.

---
`;

describe('list_recent_updates', () => {
  let t: TestClient;
  let restore = (): void => {};

  beforeEach(async () => {
    seedFixtures();
    seedFullTextSections(FLUTTER_SOURCE.id, DATED_FLUTTER);
    t = await connectClient();
  });

  afterEach(async () => {
    restore();
    restore = () => {};
    await t.close();
  });

  it('carries the updates in its structured content', async () => {
    const result = await t.client.callTool({
      name: 'list_recent_updates',
      arguments: { days: 365, source: 'flutter' },
    });
    expect(result.structuredContent).toMatchObject({
      days: 365,
      source: 'flutter',
      total: 2,
      failedSources: [],
      message: '2 pages updated in the last 365 days.',
    });
    expect((result.structuredContent as { updates: unknown[] }).updates[0]).toEqual({
      title: 'Routing & Navigation',
      source: 'flutter',
      date: expect.any(String),
      url: 'https://developer.magiclane.com/docs/flutter/examples/routing-navigation',
      path: '/docs/flutter/examples/routing-navigation.md',
    });
    const none = await t.client.callTool({ name: 'list_recent_updates', arguments: { days: 1, source: 'android' } });
    expect(none.structuredContent).toMatchObject({ total: 0, updates: [], message: expect.stringContaining('No ') });
  });

  it('errors on an empty page-contents file instead of reporting no recent updates', async () => {
    seedFullTextSections('android', '');
    const result = await t.client.callTool({ name: 'list_recent_updates', arguments: { days: 30, source: 'android' } });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('a problem with the file(s) published on developer.magiclane.com');
    expect(textOf(result)).toContain('- android page contents (llms-full.txt): the file holds no pages');
    expect(textOf(result)).not.toContain('retry shortly');
  });

  it('lists pages updated within the window, with dates, source and URL', async () => {
    const text = textOf(
      await t.client.callTool({ name: 'list_recent_updates', arguments: { days: 30, source: 'flutter' } })
    );
    expect(text).toContain('# Documentation updated in the last 30 days');
    expect(text).toContain('1 page updated in the last 30 days');
    expect(text).toContain(
      '**Routing & Navigation** (source: flutter) — https://developer.magiclane.com/docs/flutter/examples/routing-navigation'
    );
    expect(text).not.toContain('Calculate Route');
  });

  it('includes older pages when the window is wide enough and honours the limit', async () => {
    const wide = textOf(
      await t.client.callTool({ name: 'list_recent_updates', arguments: { days: 365, source: 'flutter' } })
    );
    expect(wide).toContain('2 pages updated in the last 365 days');
    expect(wide).toContain('**Calculate Route**');
    const limited = textOf(
      await t.client.callTool({ name: 'list_recent_updates', arguments: { days: 365, source: 'flutter', limit: 1 } })
    );
    expect(limited).toContain(
      'Pages 1–1 of 2 updated in the last 365 days, newest first (call again with offset: 1 for the next ones)'
    );
    expect(limited).not.toContain('2 pages updated');
    // The rest of the window is reachable with offset, to its end.
    const next = await t.client.callTool({
      name: 'list_recent_updates',
      arguments: { days: 365, source: 'flutter', limit: 1, offset: 1 },
    });
    expect(textOf(next)).toContain('Pages 2–2 of 2 updated in the last 365 days, newest first');
    expect(next.structuredContent).toMatchObject({ offset: 1, total: 2 });
    expect(next.structuredContent).not.toHaveProperty('nextOffset');
    const beyond = await t.client.callTool({
      name: 'list_recent_updates',
      arguments: { days: 365, source: 'flutter', offset: 2 },
    });
    expect(isError(beyond)).toBe(true);
    expect(textOf(beyond)).toContain('offset 2 is beyond the 2 page(s) updated in the last 365 days');
  });

  it('scans every source when source is omitted, including the developer guides', async () => {
    seedFullTextSections('developer', `## Docs\n\n### Get Started\n\nLast updated: ${siteDate(1)}\n\nBody.\n`);
    const text = textOf(await t.client.callTool({ name: 'list_recent_updates', arguments: { days: 7 } }));
    expect(text).toContain('**Routing & Navigation** (source: flutter)');
    expect(text).toContain('**Get Started** (source: developer)');
  });

  it('lists a dated page without a URL when the index does not know it', async () => {
    seedFullTextSections('android', `## Docs\n\n### Orphan\n\nLast updated: ${siteDate(2)}\n\nBody.\n`);
    const text = textOf(
      await t.client.callTool({ name: 'list_recent_updates', arguments: { days: 7, source: 'android' } })
    );
    expect(text).toMatch(/\*\*Orphan\*\* \(source: android\)$/m);
    expect(text).not.toContain('(source: android) —');
  });

  it('shows the newest pages when the window holds none, and says how old they are', async () => {
    const result = await t.client.callTool({ name: 'list_recent_updates', arguments: { days: 1, source: 'flutter' } });
    expect(isError(result)).toBe(false);
    const text = textOf(result);
    expect(text).toContain("No documentation pages show a 'Last updated' date within the last 1 days");
    expect(text).toContain(`The newest dated page is from ${isoDate(3)}.`);
    expect(text).toContain('## Newest pages\n\nAll older than the 1-day window:\n\n');
    expect(text).toMatch(/- \d{4}-\d{2}-\d{2} — \*\*Routing & Navigation\*\* \(source: flutter\)/);
    const structured = result.structuredContent as {
      total: number;
      updates: unknown[];
      newestDate: string;
      newestPages: Array<{ title: string; date: string }>;
    };
    expect(structured.total).toBe(0);
    expect(structured.updates).toEqual([]);
    expect(structured.newestDate).toBe(isoDate(3));
    expect(structured.newestPages.map((u) => u.title)).toEqual(['Routing & Navigation', 'Calculate Route']);

    // No dated page at all: nothing to fall back on.
    const none = await t.client.callTool({ name: 'list_recent_updates', arguments: { days: 1, source: 'android' } });
    expect(textOf(none)).not.toContain('Newest pages');
    expect(textOf(none)).not.toContain('newest dated page');
    expect(none.structuredContent).not.toHaveProperty('newestDate');
    expect((none.structuredContent as { newestPages: unknown[] }).newestPages).toEqual([]);
  });

  it('names sources whose pages could not be loaded, and errors when none could', async () => {
    resetCaches();
    seedIndex('flutter', FLUTTER_LLMS);
    seedFullTextSections('flutter', DATED_FLUTTER);
    ({ restore } = stubFetch({}));
    const partial = await t.client.callTool({ name: 'list_recent_updates', arguments: { days: 30 } });
    expect(isError(partial)).toBe(false);
    expect(textOf(partial)).toContain('## Sources not loaded');
    expect(textOf(partial)).toContain('- ios page contents (llms-full.txt): HTTP 404');
    const none = await t.client.callTool({ name: 'list_recent_updates', arguments: { source: 'ios' } });
    expect(isError(none)).toBe(true);
    expect(textOf(none)).toContain('Could not load the page contents (llms-full.txt)');
    expect(textOf(none)).toContain('so nothing was listed');
  });

  it('says why pages are listed without links when only their index failed', async () => {
    resetCaches();
    seedFullTextSections('flutter', DATED_FLUTTER);
    ({ restore } = stubFetch({}));
    const text = textOf(
      await t.client.callTool({ name: 'list_recent_updates', arguments: { days: 30, source: 'flutter' } })
    );
    expect(text).not.toContain('## Sources not loaded');
    expect(text).toContain('## Pages without links');
    expect(text).toContain('The index of flutter could not be loaded, so pages from there are listed without URLs');
    expect(text).toContain('- flutter: HTTP 404');
  });

  it('rejects an out-of-range window with a validation error', async () => {
    const result = await t.client.callTool({ name: 'list_recent_updates', arguments: { days: 0 } });
    expect(isError(result)).toBe(true);
  });
});
