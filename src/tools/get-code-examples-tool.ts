/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BaseTool, READ_ONLY_ANNOTATIONS } from './base-tool.js';
import { DOCS, LIMITS } from '../config/constants.js';
import type { DocSource } from '../config/constants.js';
import { getDocument } from '../docs/document.js';
import type { FetchedDocument } from '../docs/document.js';
import { loadIndex, peekIndex, searchIndex, sourceRoot, tokenize } from '../docs/docs-index.js';
import type { DocEntry } from '../docs/docs-index.js';
import {
  extractCodeBlocks,
  filterByCaption,
  filterByLanguage,
  languageKey,
  splitLongBlocks,
} from '../docs/code-examples.js';
import type { CodeBlock } from '../docs/code-examples.js';
import { loadFullTextSections, peekFullTextSections } from '../docs/full-text.js';
import type { FullTextLoad, FullTextSection } from '../docs/full-text.js';
import { errorMessage } from '../utils/errors.js';
import { quoteArgument } from '../utils/quote.js';

const InputSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(LIMITS.maxRefChars)
    .describe('Absolute developer.magiclane.com URL or a /docs/... path of the page.'),
  language: z
    .string()
    .max(LIMITS.maxFilterChars)
    .optional()
    .describe('Only return blocks with this language tag (aliases like ts/kt/c++/yml are honoured).'),
  caption: z
    .string()
    .max(LIMITS.maxFilterChars)
    .optional()
    .describe(
      'Only return blocks whose caption — the label line introducing the block, e.g. "Request Body" or ' +
        '"Response Body (error code 200)" — contains this text (case-insensitive). Only labelled blocks ' +
        'match: on the REST API pages caption: "request" keeps the labelled request bodies; a request ' +
        'body that follows a field list without a label is not found this way.'
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      'Skip this many matching blocks (for paging through pages with many examples). A block longer ' +
        'than maxChars is split into parts, and each part counts as one block here.'
    ),
  maxChars: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.maxDocumentChars)
    .default(LIMITS.maxCodeExampleChars)
    .describe(
      `Character budget for the returned code (default ${LIMITS.maxCodeExampleChars}, at most ` +
        `${LIMITS.maxDocumentChars}). A longer block is returned in parts.`
    ),
});

/** Room left in the budget for a part's header and fences. */
const PART_OVERHEAD = 200;
/** The size of the parts a long block is cut into when the budget is smaller than that (a block's last part may be shorter). */
const MIN_PART_CHARS = 2_000;

type Input = z.infer<typeof InputSchema>;

/** How many nearby pages to point at when a page has no matching code. */
const NEARBY_PAGES = 5;

/** How long a "no matching code" answer waits for the index and page contents to point elsewhere. */
const NEARBY_WAIT_MS = 2_000;

/** What the nearby-pages scan needs of a code block: its language (as `languageKey` gives it) and caption. */
interface BlockTag {
  language: string;
  caption: string;
}

/**
 * The pages of a source related to a page's title, in tiers, best first:
 * those about its most specific word (in their title or section), then those
 * that mention every word of the title and share one in their own title
 * ("Adjust the map view" for "Center Map", which no other title says) — not
 * every page that merely shares a word. A tier is pointed at only when none
 * of the tier before holds matching code (see nearbyPages): "Calculate Route
 * Multi View" answers for "Calculate Route", not every page that mentions
 * calculating a route as well ("Reoptimize Route").
 */
function relatedPages(entries: DocEntry[], title: string, self: string): DocEntry[][] {
  const hits = searchIndex(entries, title, Number.POSITIVE_INFINITY).filter((e) => e.path !== self);
  const words = new Set(tokenize(title));
  const about = hits.filter((e) => e.rarestInHeading);
  const near = hits.filter((e) => !e.rarestInHeading && e.coverage >= 1 && tokenize(e.title).some((w) => words.has(w)));
  if (about.length + near.length > 0 || words.size < 3) return [about, near];
  // No other page names its most specific word ("Switch Map Perspective"):
  // the pages whose titles hold all its other words ("Map Perspective") —
  // two at least, so a title is never related on one shared word.
  return [
    hits.filter((e) => {
      const own = new Set(tokenize(e.title));
      return [...words].filter((w) => own.has(w)).length >= words.size - 1;
    }),
  ];
}

/** The least share of an example's title (weighted as the index weighs words) a guide on its topic covers. */
const GUIDE_COVERAGE = 0.4;

/**
 * The guides of a source on an example page's topic, best first: the pages
 * outside the examples headed (title or section) with a word of its title,
 * that cover at least GUIDE_COVERAGE of it and are in its area — their
 * section or title names a word of the example's category ("Places &
 * Search"). That is where an example that holds no code itself, and has no
 * related example that does, points ("Free Text Search": "Getting started
 * with Search"; "Switch Map Perspective": "Adjust the map view", which says
 * "perspective") — not every guide that says "map", nor fleet "Progress
 * Tracking" for the routing example "Export Track".
 */
function guidesOn(entries: DocEntry[], example: DocEntry): DocEntry[] {
  const words = new Set(tokenize(example.title));
  const category = new Set(tokenize(example.section.split(' › ').slice(1).join(' ')));
  const guides = entries.filter((e) => !e.path.includes('/examples/'));
  return searchIndex(guides, example.title, Number.POSITIVE_INFINITY, { corpus: entries }).filter(
    (e) =>
      e.coverage >= GUIDE_COVERAGE &&
      tokenize(`${e.title} ${e.section}`).some((w) => words.has(w)) &&
      tokenize(`${e.section} ${e.title}`).some((w) => category.has(w))
  );
}

/**
 * The language and caption of every code block of a page, kept per
 * page-contents section: extracting the blocks is what makes a scan of the
 * pages below an overview page cost, and a section lives as long as the page
 * contents it came from, so each page is extracted once per download however
 * often it is scanned.
 */
const blockTags = new WeakMap<FullTextSection, BlockTag[]>();

function tagsOf(section: FullTextSection): BlockTag[] {
  let tags = blockTags.get(section);
  if (!tags) {
    tags = extractCodeBlocks(section.body).map((b) => ({
      language: languageKey(b.language),
      caption: b.caption?.toLowerCase() ?? '',
    }));
    blockTags.set(section, tags);
  }
  return tags;
}

/** `work`'s result, or undefined when it takes longer than NEARBY_WAIT_MS (it carries on regardless). */
async function withinNearbyWait<T>(work: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), NEARBY_WAIT_MS);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The index and page contents of a source as held in memory, fresh or stale,
 * for when loading them takes longer than NEARBY_WAIT_MS (a refresh that
 * hangs): undefined without an index in memory; the page contents count as not
 * loaded when there is no copy of them.
 */
function inMemory(
  sourceId: string
): { entries: DocEntry[]; fullText: Pick<FullTextLoad, 'sections' | 'failed'> } | undefined {
  const entries = peekIndex(sourceId);
  if (!entries) return undefined;
  const sections = peekFullTextSections(sourceId);
  return {
    entries,
    fullText: sections
      ? { sections, failed: [] }
      : {
          sections: [],
          failed: [{ source: sourceId, part: 'full-text', reason: 'not loaded in time', kind: 'unreachable' }],
        },
  };
}

/** The source whose pages include this path: the one with the longest root the path starts with (every path is under /docs/). */
function sourceOfPath(path: string): DocSource {
  return DOCS.sources
    .filter((s) => path.startsWith(sourceRoot(s)))
    .sort((a, b) => sourceRoot(b).length - sourceRoot(a).length)[0] as DocSource;
}

/**
 * The fence to print a block in: one backtick more than the longest run of
 * backticks opening one of its lines (three at least), so a markdown sample
 * holding its own fences cannot close it early.
 */
export function fenceFor(code: string, language = ''): string {
  // A backtick in the info string is not allowed on a backtick fence
  // (CommonMark): such a block came in a tilde fence and goes out in one.
  const mark = language.includes('`') ? '~' : '`';
  let longest = 2;
  for (const m of code.matchAll(new RegExp(`^\\s*(${mark}{3,})`, 'gm')))
    longest = Math.max(longest, (m[1] as string).length);
  return mark.repeat(longest + 1);
}

/** The page's languages with their block counts, most blocks first: "dart (3), json (2)". */
function languageTally(blocks: CodeBlock[]): string {
  const counts = new Map<string, number>();
  for (const b of blocks) counts.set(b.language, (counts.get(b.language) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([language, n]) => `${language} (${n})`)
    .join(', ');
}

/**
 * Where else the examples may be: an overview page ("Get started") often
 * holds no code while the pages below it do, and an examples page may only
 * point elsewhere while the guides of the same name carry the code. The pages
 * below this one from the index, else the pages of the same source about
 * its title's most specific word — and last, for an example, the guides on
 * its topic (see guidesOn) — each with its count of blocks matching the
 * filters (from the source's page contents, which a search loads anyway);
 * listed unchecked when those contents could not be loaded. When the index
 * and contents take longer than NEARBY_WAIT_MS (a cold start, a slow site),
 * the copies in memory are used, stale or not; without one, the answer says
 * the nearby pages could not be checked: it does not wait for them.
 */
async function nearbyPages(
  doc: FetchedDocument,
  language: string | undefined,
  caption: string | undefined
): Promise<string> {
  const source = sourceOfPath(doc.path);
  const fresh = await withinNearbyWait(
    (async () => {
      const index = await loadIndex([source.id]);
      const fullText = await loadFullTextSections([source.id], index);
      return { entries: index.entries, failed: index.failed, fullText };
    })()
  );
  // Too slow, or failed at once (unreachable, a 404, an HTML page): the copies in memory, if any.
  const loaded = fresh && fresh.entries.length > 0 ? fresh : inMemory(source.id);
  if (!loaded) {
    // Said by what happened: no answer in time, or a failure (a 404 comes back at once).
    const why =
      fresh === undefined
        ? `within ${NEARBY_WAIT_MS / 1000} s (the site is slow or unreachable)`
        : `(${fresh.failed.map((f) => f.reason).join('; ')})`;
    return (
      `\n\nWhich nearby pages hold code could not be checked: the ${source.id} index could not be loaded ` +
      `${why}. search_docs finds related pages.`
    );
  }
  const { entries } = loaded;
  const below = `${doc.path.replace(/\.md$/, '')}/`;
  const children = entries.filter((e) => e.path.startsWith(below));
  const self = entries.find((e) => e.path === doc.path);
  const title = self?.title ?? /^#\s+(.+)$/m.exec(doc.content)?.[1] ?? '';
  // The candidates in tiers (see relatedPages); the pages below a page are
  // one tier, and the guides on an example's topic a last one (see guidesOn).
  const tiers: Array<{ pages: DocEntry[]; where: string }> =
    children.length > 0
      ? [{ pages: children, where: 'Pages below it' }]
      : title === ''
        ? []
        : [
            ...relatedPages(entries, title, doc.path).map((pages) => ({ pages, where: 'Related pages' })),
            ...(self?.path.includes('/examples/')
              ? [{ pages: guidesOn(entries, self), where: 'Guides on its topic' }]
              : []),
          ];
  const candidates = tiers.flatMap((t) => t.pages);
  if (candidates.length === 0) return '';
  const { sections, failed } = loaded.fullText;
  if (failed.length > 0) {
    const lines = candidates.slice(0, NEARBY_PAGES).map((e) => `- ${e.title} — ${e.url}`);
    const where = children.length > 0 ? 'Pages below it' : 'Related pages';
    return `\n\n${where}, not checked for code (the page contents could not be loaded):\n${lines.join('\n')}`;
  }
  const pages = new Map(sections.filter((s) => s.path !== undefined).map((s) => [s.path as string, s]));
  const key = language ? languageKey(language) : undefined;
  const wantedCaption = caption?.trim().toLowerCase() ?? '';
  const lines: string[] = [];
  let where = '';
  // The first tier with a page holding matching code is the one pointed at;
  // one more page than is shown, to know whether there are more.
  for (const tier of tiers) {
    where = tier.where;
    for (const e of tier.pages) {
      const page = pages.get(e.path);
      if (page === undefined) continue;
      const count = tagsOf(page).filter(
        (t) => (key === undefined || t.language === key) && t.caption.includes(wantedCaption)
      ).length;
      if (count > 0) lines.push(`- ${e.title} — ${e.url} (${count} ${language ? `${language} ` : ''}block(s))`);
      if (lines.length > NEARBY_PAGES) break;
    }
    if (lines.length > 0) break;
  }
  if (lines.length === 0) return '';
  const shown = lines.length > NEARBY_PAGES ? ` (the first ${NEARBY_PAGES})` : '';
  const kind = [
    language ? `${language} ` : '',
    'code blocks',
    wantedCaption ? ` captioned "${quoteArgument(caption as string)}"` : '',
  ].join('');
  return `\n\n${where} with ${kind}${shown}:\n${lines.slice(0, NEARBY_PAGES).join('\n')}`;
}

export class GetCodeExamplesTool extends BaseTool<typeof InputSchema> {
  readonly name = 'get_code_examples';
  readonly description =
    'Extract only the code blocks from a Magic Lane documentation page (by URL or /docs/... ' +
    'path), skipping the surrounding tutorial prose. Optionally filter by language tag ' +
    '(e.g. dart, kotlin, swift, cpp, typescript, json, shell) and by caption — the line that ' +
    'introduces a block, such as "Request Body" or "Response Body" on the REST API pages. Each ' +
    'block comes with its nearest heading and caption. Much cheaper than ' +
    'read_doc when only the sample code matters. Long pages are paged: the response says how ' +
    'many blocks remain and which offset continues; a block longer than the budget comes in parts. ' +
    'When a page has no matching block, the response names the languages it does have and the pages ' +
    'below it (or related pages, or for an example page the guides on its topic) that hold such blocks, ' +
    'with counts — listed unchecked when the page ' +
    'contents cannot be loaded, and not at all, saying so, when the index cannot be loaded in time.';
  readonly annotations: ToolAnnotations = {
    ...READ_ONLY_ANNOTATIONS,
    title: 'Get code examples from a Magic Lane documentation page',
  };

  constructor() {
    super({ inputSchema: InputSchema });
  }

  async run(rawInput: unknown): Promise<CallToolResult> {
    const { url, caption, offset, maxChars } = rawInput as Input;
    // A blank language is no filter, as a blank caption is.
    const language = (rawInput as Input).language?.trim() || undefined;
    try {
      const doc = await getDocument(url);
      const all = extractCodeBlocks(doc.content);
      const found = filterByCaption(filterByLanguage(all, language), caption);
      if (found.length === 0) {
        // The filters as given, quoted on one line (see quoteArgument).
        const filters = [
          language ? `language "${quoteArgument(language)}"` : '',
          caption ? `caption "${quoteArgument(caption)}"` : '',
        ]
          .filter((f) => f !== '')
          .join(' and ');
        const tally = filters && all.length > 0 ? ` Its blocks are ${languageTally(all)}.` : '';
        const nearby = await nearbyPages(doc, language, caption);
        return this.textResponse(
          (filters
            ? `No code blocks matching ${filters} on ${doc.url} (${all.length} block(s) in all).${tally}`
            : `No code blocks found on ${doc.url}.`) +
            nearby +
            (filters
              ? '\n\nTry without the filter, or read the full page with read_doc.'
              : '\n\nRead the full page with read_doc.')
        );
      }
      const blocks = splitLongBlocks(found, Math.max(MIN_PART_CHARS, maxChars - PART_OVERHEAD));
      if (offset >= blocks.length) {
        return this.errorResponse(`offset ${offset} is beyond the last code block (${blocks.length} on ${doc.url}).`);
      }

      const parts: string[] = [];
      let used = 0;
      let next = offset;
      for (; next < blocks.length; next++) {
        const b = blocks[next]!;
        const partLabel = b.parts > 1 ? `, part ${b.part} of ${b.parts}${b.midLine ? ', ends mid-line' : ''}` : '';
        const part =
          `## Example ${b.block + 1} (${b.language}${partLabel})${b.heading ? ` — ${b.heading}` : ''}` +
          `${b.caption ? ` · ${b.caption}` : ''}\n\n` +
          `${fenceFor(b.code, b.language)}${b.language}\n${b.code}\n${fenceFor(b.code, b.language)}`;
        // Always return at least one block; split parts keep even that one near the budget.
        if (parts.length > 0 && used + part.length > maxChars) break;
        parts.push(part);
        used += part.length;
      }
      const remaining = blocks.length - next;
      const unit = blocks.length > found.length ? 'Parts' : 'Blocks';
      const paging =
        remaining > 0
          ? `${unit} ${offset + 1}–${next} of ${blocks.length}; ${remaining} more — call again with offset: ${next}.`
          : offset > 0
            ? `${unit} ${offset + 1}–${next} of ${blocks.length} (last).`
            : `${blocks.length} block(s)`;
      const split =
        blocks.length > found.length
          ? ` (${found.length} blocks; those longer than the budget are split into parts, and offsets count parts)`
          : '';
      return this.textResponse(`# Code examples from ${doc.url}\n\n${paging}${split}\n\n${parts.join('\n\n')}`);
    } catch (err) {
      return this.errorResponse(`Failed to fetch document "${quoteArgument(url)}": ${errorMessage(err)}`);
    }
  }
}
