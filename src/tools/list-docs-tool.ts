/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BaseTool, READ_ONLY_ANNOTATIONS } from './base-tool.js';
import {
  BRIEF_DESCRIPTION_CHARS,
  FAILED_SOURCES_SCHEMA,
  PAGE_SCHEMA,
  briefDescription,
  briefPageOf,
} from './output-schemas.js';
import { allSourcesFailedMessage, sourceFailureNote } from './source-report.js';
import { DOCS, LIMITS } from '../config/constants.js';
import type { DocEntry } from '../docs/docs-index.js';
import { loadIndex, selectSources } from '../docs/docs-index.js';
import { quoteArgument } from '../utils/quote.js';

const sourceIds = DOCS.sources.map((s) => s.id) as [string, ...string[]];

/** "1 page", "2 pages". */
function pagesWord(count: number): string {
  return `${count} ${count === 1 ? 'page' : 'pages'}`;
}

/** The TOC's label for pages outside any section; also accepted as a section filter. */
const TOP_LEVEL = '(top level)';

const InputSchema = z.object({
  source: z
    .enum(['all', ...sourceIds])
    .default('all')
    .describe('Restrict listing to one documentation source.'),
  section: z
    .string()
    .max(LIMITS.maxFilterChars)
    .optional()
    .describe(
      'Optional case-insensitive filter on the section, e.g. "routing" or "Examples › Maps & 3D Scene". ' +
        'Sections mirror the documentation URL: "Examples › <category>" and "Guides › <topic>".'
    ),
  mode: z
    .enum(['sections', 'pages'])
    .optional()
    .describe('"sections" = compact TOC with page counts; "pages" = full page list. See default above.'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('In "pages" mode: skip this many pages (for paging through a long listing).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.maxListPages)
    .default(LIMITS.defaultListPages)
    .describe(
      `In "pages" mode: pages per response (default ${LIMITS.defaultListPages}, at most ${LIMITS.maxListPages}).`
    ),
});

const OutputSchema = z.object({
  mode: z.enum(['sections', 'pages']),
  total: z.number().int().describe('Pages matching the source and section filters.'),
  message: z.string().describe('What the listing shows and how to continue (paging, or how to drill down).'),
  sections: z
    .array(z.object({ source: z.string(), section: z.string(), pages: z.number().int() }))
    .describe('"sections" mode: every section with its page count. Empty in "pages" mode.'),
  pages: z.array(PAGE_SCHEMA).describe('"pages" mode: the pages of this slice. Empty in "sections" mode.'),
  offset: z.number().int().describe('"pages" mode: position of the first page of this slice.'),
  nextOffset: z.number().int().optional().describe('"pages" mode: offset of the next slice; absent at the end.'),
  failedSources: FAILED_SOURCES_SCHEMA,
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export class ListDocsTool extends BaseTool<typeof InputSchema, typeof OutputSchema> {
  readonly name = 'list_docs';
  readonly description =
    'Browse the Magic Lane documentation index (llms.txt). mode "sections" returns a compact ' +
    'table of contents (sections with page counts); mode "pages" lists pages with title, URL and the ' +
    `description (one over ${BRIEF_DESCRIPTION_CHARS} characters cut to its first sentence, or at a word — where the room ` +
    'ends when its second half has no space; search_docs gives it whole), ' +
    `${LIMITS.defaultListPages} per call by default, ${LIMITS.maxListPages} at most (page with offset). ` +
    'When mode is omitted it defaults to "sections" for source "all" without a section filter, and ' +
    '"pages" otherwise. Start with the TOC, then drill into one source/section with mode "pages".';
  readonly annotations: ToolAnnotations = {
    ...READ_ONLY_ANNOTATIONS,
    title: 'List Magic Lane documentation pages',
  };

  constructor() {
    super({ inputSchema: InputSchema, outputSchema: OutputSchema });
  }

  async run(rawInput: unknown): Promise<CallToolResult> {
    const { source, mode, offset, limit } = rawInput as Input;
    // A blank filter is no filter (an empty string matches every section).
    const section = (rawInput as Input).section?.trim() || undefined;
    const effectiveMode = mode ?? (source === 'all' && !section ? 'sections' : 'pages');
    const sources = source === 'all' ? undefined : [source];
    const index = await loadIndex(sources);
    if (index.failed.length === selectSources(sources).length) {
      return this.errorResponse(allSourcesFailedMessage('documentation index', index.failed, 'listed'));
    }
    const note = sourceFailureNote(index.failed);
    // "(top level)", as the TOC labels pages outside any section, picks those pages.
    const wanted = section?.toLowerCase();
    const filtered =
      wanted === undefined
        ? index.entries
        : index.entries.filter((e) =>
            wanted === TOP_LEVEL ? e.section === '' : e.section.toLowerCase().includes(wanted)
          );
    const structured = (fields: Partial<Output> & { message: string }): Output => ({
      mode: effectiveMode,
      total: filtered.length,
      sections: [],
      pages: [],
      offset,
      failedSources: index.failed,
      ...fields,
    });

    // Every loaded source lists pages (an empty index counts as failed), so
    // only a section filter can leave nothing.
    if (filtered.length === 0) {
      const message =
        `No documentation pages match the given filters (section "${quoteArgument(section as string)}"). ` +
        'Call list_docs with mode "sections" to see the available sections.';
      return this.textResponse(message + note, structured({ message }));
    }

    if (effectiveMode === 'sections') {
      const bySourceToc = new Map<string, Map<string, number>>();
      for (const entry of filtered) {
        const sections = bySourceToc.get(entry.source) ?? new Map<string, number>();
        sections.set(entry.section, (sections.get(entry.section) ?? 0) + 1);
        bySourceToc.set(entry.source, sections);
      }
      const tocBlocks: string[] = [];
      const toc: Output['sections'] = [];
      for (const [sourceId, sections] of bySourceToc) {
        const sourceName = DOCS.sources.find((s) => s.id === sourceId)!.name;
        const lines = [...sections].map(([name, count]) => `- ${name || TOP_LEVEL} — ${pagesWord(count)}`);
        tocBlocks.push(`# ${sourceName} (source: ${sourceId})\n${lines.join('\n')}`);
        for (const [name, count] of sections) toc.push({ source: sourceId, section: name, pages: count });
      }
      const message =
        `${pagesWord(filtered.length)} across ${bySourceToc.size} source(s). ` +
        `Call again with mode: "pages" plus a source and/or section filter for the full listing.`;
      return this.textResponse(
        `${message}\n\n` + tocBlocks.join('\n\n') + note,
        structured({ message, sections: toc })
      );
    }

    const page = filtered.slice(offset, offset + limit);
    if (page.length === 0) {
      return this.errorResponse(
        `offset ${offset} is beyond the end of the listing (${pagesWord(filtered.length)}).` + note
      );
    }

    // Group: source -> section -> entries
    const bySource = new Map<string, Map<string, DocEntry[]>>();
    for (const entry of page) {
      const sections = bySource.get(entry.source) ?? new Map<string, DocEntry[]>();
      const list = sections.get(entry.section) ?? [];
      list.push(entry);
      sections.set(entry.section, list);
      bySource.set(entry.source, sections);
    }

    const blocks: string[] = [];
    for (const [sourceId, sections] of bySource) {
      // Entries always originate from DOCS.sources, so the lookup cannot miss.
      const sourceName = DOCS.sources.find((s) => s.id === sourceId)!.name;
      blocks.push(`# ${sourceName} (source: ${sourceId})`);
      for (const [sectionName, list] of sections) {
        if (sectionName) blocks.push(`## ${sectionName}`);
        blocks.push(
          list
            .map((e) => `- [${e.title}](${e.url})${e.description ? ` — ${briefDescription(e.description)}` : ''}`)
            .join('\n')
        );
      }
    }

    const end = offset + page.length;
    const paging =
      end < filtered.length
        ? `Showing pages ${offset + 1}–${end} of ${filtered.length}. Call again with offset: ${end} for the next ${Math.min(limit, filtered.length - end)}.`
        : offset > 0
          ? `Showing pages ${offset + 1}–${end} of ${filtered.length} (end of listing).`
          : pagesWord(filtered.length);

    return this.textResponse(
      `${paging}\n\n` + blocks.join('\n\n') + note,
      structured({
        message: paging,
        pages: page.map(briefPageOf),
        ...(end < filtered.length ? { nextOffset: end } : {}),
      })
    );
  }
}
