/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Last updated" extraction from llms-full.txt pages. Every documentation
 * page embeds a `Last updated: <Month D, YYYY>` marker that survives into the
 * concatenated full-text export, so recency can be computed without fetching
 * individual pages.
 */
import type { FullTextSection } from './full-text.js';

const LAST_UPDATED = /Last updated:(?:\s|<!-- -->)*([A-Za-z]+) (\d{1,2}), (\d{4})/;

const MONTHS: Record<string, number> = Object.assign(Object.create(null) as Record<string, number>, {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
});

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DocUpdate {
  title: string;
  source: string;
  url?: string;
  path?: string;
  /** ISO date (yyyy-mm-dd) of the page's "Last updated" marker. */
  date: string;
}

/**
 * Parse the "Last updated" date of one page body; null when absent, not a
 * real calendar date (February 30), or unparsable. The date is anchored at
 * UTC midnight, so the resulting ISO date is the same regardless of the
 * server's timezone.
 */
export function parseLastUpdated(body: string): Date | null {
  const match = body.match(LAST_UPDATED);
  if (!match) return null;
  // Groups 1–3 are guaranteed present by the match.
  const month = MONTHS[(match[1] as string).toLowerCase()];
  if (month === undefined) return null;
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  // Date.UTC rolls February 30 over to March 2; refuse such markers instead.
  if (date.getUTCDate() !== day || date.getUTCMonth() !== month) return null;
  return date;
}

/**
 * The newest "Last updated" date (ISO yyyy-mm-dd) among the pages, or
 * undefined when none carries one. Markers dated beyond tomorrow are ignored,
 * as collectRecentUpdates ignores them. `now` is injectable for testing.
 */
export function newestUpdate(sections: FullTextSection[], now: number = Date.now()): string | undefined {
  const horizon = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
  let newest: Date | undefined;
  for (const section of sections) {
    const date = parseLastUpdated(section.body);
    if (date && date.getTime() <= horizon && (!newest || date > newest)) newest = date;
  }
  return newest?.toISOString().slice(0, 10);
}

/**
 * Collect pages updated within the last `days` calendar days (UTC), newest
 * first. The window is inclusive of today and of the day `days` ago at
 * midnight, so `days: 1` means "yesterday or today". Markers dated in the
 * future (beyond tomorrow, allowing for timezones) are ignored. `now` is
 * injectable for testing.
 */
export function collectRecentUpdates(sections: FullTextSection[], days: number, now: number = Date.now()): DocUpdate[] {
  const todayUtc = Math.floor(now / DAY_MS) * DAY_MS;
  const threshold = todayUtc - days * DAY_MS;
  const horizon = todayUtc + DAY_MS;
  const updates: Array<DocUpdate & { time: number }> = [];
  for (const section of sections) {
    const date = parseLastUpdated(section.body);
    if (!date) continue;
    const time = date.getTime();
    if (time < threshold || time > horizon) continue;
    updates.push({
      title: section.title,
      source: section.source,
      url: section.url,
      path: section.path,
      date: date.toISOString().slice(0, 10),
      time,
    });
  }
  updates.sort((a, b) => b.time - a.time || a.title.localeCompare(b.title));
  return updates.map(({ time: _time, ...update }) => update);
}
