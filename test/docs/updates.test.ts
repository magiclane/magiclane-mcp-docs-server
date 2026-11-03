/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { collectRecentUpdates, newestUpdate, parseLastUpdated } from '../../src/docs/updates.js';
import type { FullTextSection } from '../../src/docs/full-text.js';

const DAY = 24 * 60 * 60 * 1000;
/** 2026-09-15T10:00Z — a fixed "now" so the window arithmetic is checkable. */
const NOW = Date.UTC(2026, 8, 15, 10);

function section(title: string, body: string, extra: Partial<FullTextSection> = {}): FullTextSection {
  return {
    title,
    body,
    source: 'flutter',
    titleLower: title.toLowerCase(),
    bodyLower: body.toLowerCase(),
    titleWords: new Set(),
    words: new Map(),
    ...extra,
  };
}

describe('parseLastUpdated', () => {
  it('parses the site format with HTML comments between marker and date', () => {
    const date = parseLastUpdated('Last updated:\n\n<!-- -->\n\nAugust 12, 2026\n\n<!-- -->\n\n| 5 minutes read');
    expect(date?.toISOString()).toBe('2026-08-12T00:00:00.000Z');
  });

  it('parses a plain inline marker', () => {
    expect(parseLastUpdated('Last updated: March 3, 2026')?.toISOString().slice(0, 10)).toBe('2026-03-03');
  });

  it('returns null when the marker is absent or the month is not a month', () => {
    expect(parseLastUpdated('no marker here')).toBeNull();
    expect(parseLastUpdated('Last updated: Smarch 3, 2026')).toBeNull();
  });

  it('rejects impossible calendar dates instead of rolling them over', () => {
    expect(parseLastUpdated('Last updated: February 30, 2026')).toBeNull();
    expect(parseLastUpdated('Last updated: February 29, 2024')?.toISOString().slice(0, 10)).toBe('2024-02-29');
    expect(parseLastUpdated('Last updated: April 31, 2026')).toBeNull();
  });
});

describe('collectRecentUpdates', () => {
  const sections = [
    section('Old', 'Last updated: January 5, 2026'),
    section('Yesterday B', 'Last updated: September 14, 2026'),
    section('Yesterday A', 'Last updated: September 14, 2026', {
      url: 'https://developer.magiclane.com/docs/a.md',
      path: '/docs/a.md',
    }),
    section('Today', 'Last updated: September 15, 2026'),
    section('Tomorrow', 'Last updated: September 16, 2026'), // timezone slack: still accepted
    section('Future', 'Last updated: December 25, 2027'),
    section('Undated', 'no marker'),
    section('Week ago', 'Last updated: September 8, 2026'),
  ];

  it('keeps pages within the window, newest first, ties alphabetical, with their URLs', () => {
    expect(collectRecentUpdates(sections, 7, NOW)).toEqual([
      { title: 'Tomorrow', source: 'flutter', url: undefined, path: undefined, date: '2026-09-16' },
      { title: 'Today', source: 'flutter', url: undefined, path: undefined, date: '2026-09-15' },
      {
        title: 'Yesterday A',
        source: 'flutter',
        url: 'https://developer.magiclane.com/docs/a.md',
        path: '/docs/a.md',
        date: '2026-09-14',
      },
      { title: 'Yesterday B', source: 'flutter', url: undefined, path: undefined, date: '2026-09-14' },
      { title: 'Week ago', source: 'flutter', url: undefined, path: undefined, date: '2026-09-08' },
    ]);
  });

  it('counts calendar days: days=1 includes yesterday whatever the time of day', () => {
    const titles = collectRecentUpdates(sections, 1, NOW).map((u) => u.title);
    expect(titles).toEqual(['Tomorrow', 'Today', 'Yesterday A', 'Yesterday B']);
    expect(collectRecentUpdates(sections, 1, NOW + 13 * 60 * 60 * 1000).map((u) => u.title)).toEqual(titles);
  });

  it('ignores markers dated in the future beyond tomorrow', () => {
    expect(collectRecentUpdates(sections, 365, NOW).some((u) => u.title === 'Future')).toBe(false);
  });

  it('returns an empty list when nothing is recent', () => {
    expect(collectRecentUpdates([sections[0]!], 30, NOW)).toEqual([]);
    expect(collectRecentUpdates(sections, 30, NOW + 400 * DAY)).toEqual([]);
  });

  it('finds the newest date among the pages, or none, ignoring dates beyond tomorrow', () => {
    expect(newestUpdate(sections, Date.UTC(2028, 0, 1))).toBe('2027-12-25');
    // The "Future" marker is past tomorrow at NOW: "Tomorrow" is the newest that counts.
    expect(newestUpdate(sections, NOW)).toBe(collectRecentUpdates(sections, 1, NOW)[0]?.date);
    expect(newestUpdate([sections[0]!, sections[6]!])).toBe('2026-01-05');
    expect(newestUpdate([sections[6]!])).toBeUndefined();
  });
});
