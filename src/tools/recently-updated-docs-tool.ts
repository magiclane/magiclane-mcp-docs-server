/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BaseTool, READ_ONLY_ANNOTATIONS } from './base-tool.js';
import { FAILED_SOURCES_SCHEMA } from './output-schemas.js';
import { allSourcesFailedMessage, sourceFailureNote } from './source-report.js';
import { DOCS } from '../config/constants.js';
import { selectSources } from '../docs/docs-index.js';
import { loadFullTextSections } from '../docs/full-text.js';
import { collectRecentUpdates, newestUpdate } from '../docs/updates.js';
import type { DocUpdate } from '../docs/updates.js';

const sourceIds = DOCS.sources.map((s) => s.id) as [string, ...string[]];

const InputSchema = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .default(30)
    .describe('Look-back window in calendar days (UTC), inclusive: 1 = yesterday and today.'),
  source: z
    .enum(['all', ...sourceIds])
    .default('all')
    .describe('Restrict to one documentation source.'),
  limit: z.number().int().min(1).max(100).default(50).describe('Maximum number of pages to report.'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("How many of the window's pages, newest first, to skip: the nextOffset of the previous answer."),
});

/** How many of the newest pages to show when the window holds none. */
const FALLBACK_PAGES = 10;

const UPDATE_SCHEMA = z.object({
  title: z.string(),
  source: z.string(),
  date: z.string().describe('The page\'s "Last updated" date (yyyy-mm-dd).'),
  url: z.string().optional().describe("Absent when the source's index could not be loaded."),
  path: z.string().optional(),
});

const OutputSchema = z.object({
  days: z.number().int(),
  source: z.string(),
  message: z.string().describe('A one-line summary of the result.'),
  total: z.number().int().describe('Pages dated within the window (updates holds `limit` of them from `offset`).'),
  updates: z.array(UPDATE_SCHEMA).describe('Pages dated within the window, newest first.'),
  offset: z.number().int(),
  nextOffset: z.number().int().optional().describe('The offset that lists the next pages; absent at the end.'),
  newestDate: z
    .string()
    .optional()
    .describe('The newest "Last updated" date among the selected sources\' pages (absent when none carries one).'),
  newestPages: z
    .array(UPDATE_SCHEMA)
    .describe('Only when updates is empty: the newest pages the selected sources have, all older than the window.'),
  failedSources: FAILED_SOURCES_SCHEMA,
});

function updateLine(u: DocUpdate): string {
  return `- ${u.date} — **${u.title}** (source: ${u.source})${u.url ? ` — ${u.url}` : ''}`;
}

/** Structured form of an update: optional fields left out rather than undefined. */
function updateOf(u: DocUpdate): z.infer<typeof UPDATE_SCHEMA> {
  return {
    title: u.title,
    source: u.source,
    date: u.date,
    ...(u.url ? { url: u.url } : {}),
    ...(u.path ? { path: u.path } : {}),
  };
}

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export class RecentlyUpdatedDocsTool extends BaseTool<typeof InputSchema, typeof OutputSchema> {
  readonly name = 'list_recent_updates';
  readonly description =
    'Report which documentation pages were updated within the last N days, per source, using ' +
    "each page's embedded 'Last updated' date. Useful for tracking SDK documentation changes " +
    'without re-reading everything. Covers every source, including the developer guides. When nothing ' +
    'falls in the window, the response names the newest date there is and lists the newest pages.';
  readonly annotations: ToolAnnotations = {
    ...READ_ONLY_ANNOTATIONS,
    title: 'List recently updated Magic Lane documentation',
  };

  constructor() {
    super({ inputSchema: InputSchema, outputSchema: OutputSchema });
  }

  async run(rawInput: unknown): Promise<CallToolResult> {
    const { days, source, limit, offset } = rawInput as Input;
    const sources = source === 'all' ? undefined : [source];
    const fullText = await loadFullTextSections(sources);
    if (fullText.failed.length === selectSources(sources).length) {
      return this.errorResponse(allSourcesFailedMessage('page contents (llms-full.txt)', fullText.failed, 'listed'));
    }
    const all = collectRecentUpdates(fullText.sections, days);
    if (offset > 0 && offset >= all.length) {
      return this.errorResponse(
        `offset ${offset} is beyond the ${all.length} page(s) updated in the last ${days} days for the selected source(s).`
      );
    }
    const updates = all.slice(offset, offset + limit);
    const nextOffset = offset + updates.length < all.length ? offset + updates.length : undefined;
    const newest = newestUpdate(fullText.sections);
    // Pages whose index failed still have dates, just no links: say so where a
    // page is listed without one, apart from the failures that cost results.
    // The pages the answer will hold: the window's, or the newest ones shown instead.
    const listed =
      updates.length > 0
        ? updates
        : collectRecentUpdates(fullText.sections, Number.POSITIVE_INFINITY).slice(0, Math.min(limit, FALLBACK_PAGES));
    const shown = fullText.unlinked.filter((f) => listed.some((u) => u.source === f.source && !u.url));
    const unlinked =
      shown.length > 0
        ? `\n\n## Pages without links\n\nThe index of ${shown.map((f) => f.source).join(', ')} could not ` +
          `be loaded, so pages from there are listed without URLs:\n` +
          shown.map((f) => `- ${f.source}: ${f.reason}`).join('\n')
        : '';
    const note = sourceFailureNote(fullText.failed) + unlinked;
    const structured = (message: string, newestPages: DocUpdate[] = []): Output => ({
      days,
      source,
      message,
      total: all.length,
      updates: updates.map(updateOf),
      offset,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      ...(newest ? { newestDate: newest } : {}),
      newestPages: newestPages.map(updateOf),
      failedSources: [...fullText.failed, ...fullText.unlinked],
    });

    if (updates.length === 0) {
      // Nothing "recent" is still an answer: show the latest documented
      // changes there are, so the result is not an empty list.
      const latest = collectRecentUpdates(fullText.sections, Number.POSITIVE_INFINITY).slice(
        0,
        Math.min(limit, FALLBACK_PAGES)
      );
      const message =
        `No documentation pages show a 'Last updated' date within the last ${days} days for the selected ` +
        'source(s).' +
        (newest ? ` The newest dated page is from ${newest}.` : '');
      const fallback =
        latest.length > 0
          ? `\n\n## Newest pages\n\nAll older than the ${days}-day window:\n\n${latest.map(updateLine).join('\n')}`
          : '';
      return this.textResponse(message + fallback + note, structured(message, latest));
    }

    const body = updates.map(updateLine).join('\n');
    const paged = all.length > updates.length;
    const count = paged
      ? `Pages ${offset + 1}–${offset + updates.length} of ${all.length} updated in the last ${days} days, newest first` +
        (nextOffset !== undefined ? ` (call again with offset: ${nextOffset} for the next ones)` : '')
      : `${all.length} ${all.length === 1 ? 'page' : 'pages'} updated in the last ${days} days`;
    return this.textResponse(
      `# Documentation updated in the last ${days} days\n\n${count}\n\n${body}` + note,
      structured(`${count}.`)
    );
  }
}
