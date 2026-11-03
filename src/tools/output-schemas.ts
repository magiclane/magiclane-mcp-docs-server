/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Building blocks of the tools' declared output schemas.
 *
 * A tool that returns `structuredContent` declares an output schema, and its
 * structured content carries everything its text does. Some MCP clients show
 * the model ONLY the structured content when a result has any — a listing
 * whose structured part held nothing but `failedSources: []` reached the
 * model as an empty result.
 */
import { z } from 'zod';
import type { DocEntry } from '../docs/docs-index.js';

/** One page of the index, as every listing tool reports it. */
export const PAGE_SCHEMA = z.object({
  title: z.string(),
  url: z
    .string()
    .describe('The page on developer.magiclane.com, to link and cite — read_doc and get_code_examples take it too.'),
  path: z.string().describe("Pathname of the page's markdown (.md)."),
  description: z.string(),
  source: z.string(),
  section: z.string(),
});

/** The longest description a listing gives; a longer one is cut at its first sentence or a word. */
export const BRIEF_DESCRIPTION_CHARS = 200;

/**
 * A description short enough for a listing of up to 100 pages: whole when it
 * fits BRIEF_DESCRIPTION_CHARS, else its first sentence when that fits, else
 * cut at a word with "…" — or where the room ends, when the description has
 * no space in its second half (list_docs, the manifest and the README say
 * so). Listings give it twice (text and structured content), so the long
 * descriptions of some sources (Android: 340 characters at the median) would
 * otherwise double into a very large response.
 */
export function briefDescription(description: string): string {
  if (description.length <= BRIEF_DESCRIPTION_CHARS) return description;
  // A sentence ends at ".", "!" or "?" before a space — not at "e.g." or "i.e.".
  const sentence = /^.+?(?<!\b(?:e\.g|i\.e|etc|vs))[.!?](?=\s)/i.exec(description)?.[0];
  if (sentence !== undefined && sentence.length <= BRIEF_DESCRIPTION_CHARS) return sentence;
  // Cut where the room ends (in UTF-16 units, as the cap counts), stepping
  // back off a split surrogate pair so an emoji is never halved; at the last
  // space when that keeps at least half of the room, so an early space does
  // not cut it to a word.
  let end = BRIEF_DESCRIPTION_CHARS - 1;
  if (isLowSurrogate(description.charCodeAt(end))) end--;
  const cut = description.slice(0, end);
  const space = cut.lastIndexOf(' ');
  const kept = space >= BRIEF_DESCRIPTION_CHARS / 2 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s,;:—–-]+$/, '')}…`;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** An index entry in its structured form, with its description shortened (see briefDescription), for listings. */
export function briefPageOf(entry: DocEntry): z.infer<typeof PAGE_SCHEMA> {
  return { ...pageOf(entry), description: briefDescription(entry.description) };
}

/** An index entry in its structured form. */
export function pageOf(entry: DocEntry): z.infer<typeof PAGE_SCHEMA> {
  return {
    title: entry.title,
    url: entry.url,
    path: entry.path,
    description: entry.description,
    source: entry.source,
    section: entry.section,
  };
}

/** Source files that could not be loaded (see ./source-report.ts). */
export const FAILED_SOURCES_SCHEMA = z
  .array(
    z.object({
      source: z.string(),
      part: z.enum(['index', 'full-text']),
      reason: z.string(),
      kind: z
        .enum(['unreachable', 'file'])
        .describe('"unreachable": the site failed or timed out (retry may help); "file": no usable file there.'),
    })
  )
  .describe(
    'Source files that could not be loaded: "index" (llms.txt) or "full-text" (llms-full.txt) — a problem ' +
      'with the files on developer.magiclane.com or with reaching it, never a gap in the documentation.'
  );
