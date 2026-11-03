/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The llms-full.txt page export: splitting into pages, joining each page to
 * its index entry (and so its URL), and excerpt search.
 */
import { DOCS } from '../config/constants.js';
import type { DocSource } from '../config/constants.js';
import {
  PREFERRED_SOURCE_BOOST,
  loadIndex,
  newInternTable,
  tokenize,
  tokenizeQuery,
  topicInTitle,
  wordHit,
  wordStats,
} from './docs-index.js';
import type { DocEntry, IndexLoad, PlatformPreference, WordStats } from './docs-index.js';
import { scanMarkdown, stripAnchorArtifacts } from './markdown.js';
import { SourceMemo, sourceFailure } from './source-memo.js';
import type { SourceFailure } from './source-memo.js';

export interface FullTextSection {
  /** Page title (the `###` heading in llms-full.txt). */
  title: string;
  /** Full markdown body of the page, anchor artifacts removed. */
  body: string;
  /** Source id the page came from. */
  source: string;
  /** Lower-cased copies, computed once at load, for the exact-phrase checks. */
  titleLower: string;
  bodyLower: string;
  /**
   * The stemmed words of the title and the body (with occurrence counts and
   * first offsets), computed once at load. Queries are stemmed the same way,
   * so a word is found by lookup — the same folding on both sides, and no scan
   * of the page text per query word.
   */
  titleWords: Set<string>;
  words: WordStats;
  /** Absolute URL and path of the page, when the index lists it. */
  url?: string;
  path?: string;
}

export interface FullTextHit {
  title: string;
  source: string;
  url?: string;
  path?: string;
  /** Excerpt around the best match. */
  excerpt: string;
  score: number;
}

/**
 * Split an llms-full.txt document into pages. The export is the pages of one
 * source concatenated in index order: a `### Title` heading starts each page,
 * and pages are separated by a `---` line. Only a `###` that directly follows
 * that separator (or the leading `## Docs`) starts a page — a page whose own
 * content contains a level-3 heading must not be cut in two — and headings
 * inside fenced code never count.
 */
export function splitFullText(content: string, source: string): FullTextSection[] {
  newInternTable(source); // this parse's words; the previous copy's go with it
  const sections: FullTextSection[] = [];
  let current: { title: string; lines: string[] } | null = null;
  let previous = ''; // last non-blank line outside a fence

  const finish = (): void => {
    if (!current) return;
    let body = current.lines.join('\n').trim();
    if (body.endsWith('\n---')) body = body.slice(0, -4).trimEnd();
    else if (body === '---') body = '';
    sections.push(newSection(current.title, stripAnchorArtifacts(body), source));
  };

  for (const { text, inFence } of scanMarkdown(content.replace(/\r\n/g, '\n'))) {
    const heading = !inFence && (previous === '---' || previous === '## Docs') ? text.match(/^###\s+(.+?)\s*$/) : null;
    if (heading) {
      finish();
      current = { title: stripAnchorArtifacts(heading[1] as string).trim(), lines: [] };
    } else if (current) {
      current.lines.push(text);
    }
    if (!inFence && text.trim() !== '') previous = text.trim();
  }
  finish();
  return sections;
}

/**
 * Give each page its URL from the index. The export lists pages in index
 * order, so position is the primary key and the title the check; when the
 * two files disagree in length, fall back to the first unused entry with the
 * same title.
 */
export function attachUrls(sections: FullTextSection[], entries: DocEntry[]): void {
  const aligned = sections.length === entries.length && sections.every((s, i) => s.title === entries[i]?.title);
  if (aligned) {
    sections.forEach((s, i) => {
      s.url = (entries[i] as DocEntry).url;
      s.path = (entries[i] as DocEntry).path;
    });
    return;
  }
  const unused = new Map<string, DocEntry[]>();
  for (const e of entries) unused.set(e.title, [...(unused.get(e.title) ?? []), e]);
  for (const s of sections) {
    if (KEPT_APART.has(s)) {
      s.url = undefined;
      s.path = undefined;
      continue;
    }
    // Pages are linked in place and kept across index versions: a page this
    // index no longer lists under its title (renamed, moved, dropped) loses
    // the link an earlier index gave it.
    const match = unused.get(s.title)?.shift();
    s.url = match?.url;
    s.path = match?.path;
  }
}

/**
 * Repair a split that disagrees with the index, in the two cases the split
 * rule cannot tell apart on its own:
 *
 * - a page whose own content has a `---` rule followed by a `### Heading`
 *   looks like two pages: when the split has MORE pages than the index, the
 *   split is walked alongside the index, in order — a "page" whose title is
 *   the next index entry's starts a page, any other (a title the index does
 *   not know, or a known title out of place, such as a page's own
 *   "### Search") is merged back into the page before it. When two
 *   neighbors share the title the index lists once, the first is taken for
 *   the heading of the page before it ("### Search" closing Apply Map Style)
 *   — unless it opens the way a page does and the second does not: with
 *   the "Last updated:" line the export starts pages with, or with the
 *   index's description of that page. Then the first is the page and the
 *   second its own repeated title. A section the index does not list that
 *   opens like a page (see startsPage: "Last updated:", or a list of page
 *   cards — unless the cards all link to pages beside the page before it,
 *   or none to the page listed next, a "See also" that is its own heading),
 *   or that is titled as another number of a series the index lists
 *   ("Migrate to 3.1.4" beside "Migrate to 3.1.3"; see opensApart), is a
 *   page the index dropped, not a heading:
 *   it stays apart as an unlisted page (no URL: its excerpts carry none), with
 *   the sections after it as its own headings. A dropped page that shows
 *   none of that looks exactly like a heading and is merged the same way —
 *   except after the last listed page, where more than three such sections
 *   are an index cut short, and stay apart as unlisted pages instead of
 *   making the last page swallow them all;
 * - a page with an unclosed code fence hides every page boundary after it:
 *   when the split has FEWER pages than the index, the missing titles are
 *   looked for after a `---` inside the pages, and split back out.
 *
 * Anything else — the same number of pages with different titles, a split
 * whose order the index does not follow — is a version skew between the two
 * files (they are downloaded and expire independently), and is left alone:
 * pages then simply lack a URL until the files agree again. The input is
 * never mutated; the result is derived per (pages, index) pair, so a
 * corrected index yields a corrected result.
 */
export function reconcilePages(pages: FullTextSection[], entries: DocEntry[]): FullTextSection[] {
  if (entries.length === 0) return pages;
  if (pages.length === entries.length && pages.every((p, i) => p.title === entries[i]?.title)) return pages;
  const wanted = countTitles(entries.map((e) => e.title));

  if (pages.length > entries.length) {
    const merged: FullTextSection[] = [];
    let run: Run | null = null;
    let skew = false;
    const flush = (): void => {
      if (!run) return;
      // A page kept apart is always a new object, marked for this repair only.
      const page =
        run.parts.length === 0 && !run.unlisted
          ? run.base
          : newSection(
              run.base.title,
              run.parts.length === 0 ? run.base.body : run.parts.join('\n\n---\n\n'),
              run.base.source
            );
      if (run.unlisted) KEPT_APART.add(page);
      merged.push(page);
      run = null;
    };
    let next = 0;
    // Sections after the last listed page: merged into it only when there
    // are few (its own headings); more mean an index cut short.
    const tail: FullTextSection[] = [];
    pages.forEach((page, i) => {
      if (skew) return;
      // A page's own heading that happens to be the NEXT page's title ("###
      // Search" at the end of Apply Map Style, right before the Search
      // page): the real page follows at once with the same title, so this
      // one is a heading, not the page — unless the index lists that title
      // twice in a row.
      // A page whose own text has a "---" and a "### <its own title>" looks
      // the same ([A, X, X, B] for the index's [A, X, B]): a page's opening
      // found at the start of this section, and not as surely at the start
      // of the next, says this one is the page and the next its heading —
      // "Last updated:" being surer than the index's description, which a
      // page may also repeat right after its own heading near its start.
      const listed = entries[next] as DocEntry | undefined;
      const heading =
        pages[i + 1]?.title === page.title &&
        (entries[next + 1] as DocEntry | undefined)?.title !== page.title &&
        !(
          listed?.title === page.title &&
          pageOpening(page, listed) > pageOpening(pages[i + 1] as FullTextSection, listed)
        );
      if (next < entries.length && page.title === (entries[next] as DocEntry).title && !heading) {
        flush();
        run = { base: page, parts: [] };
        next += 1;
        return;
      }
      // Content before the first listed page: the files disagree, leave them be.
      if (!run) {
        skew = true;
        return;
      }
      if (next === entries.length) {
        tail.push(page);
        return;
      }
      // Opens like a page: one the index dropped, kept apart (unlisted: its
      // excerpts carry no URL) with the sections after it, its own headings.
      // The page before it is known by its index entry when it is listed.
      if (opensApart(page, run.unlisted ? undefined : entries[next - 1], entries[next], entries)) {
        flush();
        run = { base: page, parts: [], unlisted: true };
        return;
      }
      mergeInto(run, page);
    });
    if (skew) return pages;
    // Which sections of the tail open like a page: the page before the first
    // is the last listed one; after a section kept apart, it is unlisted.
    let before: DocEntry | undefined = entries[entries.length - 1];
    const opens = tail.map((page) => {
      const apart = opensApart(page, before, undefined, entries);
      if (apart) before = undefined;
      return apart;
    });
    if (opens.some(Boolean)) {
      // A section that opens like a page (opensApart) is a page the index
      // does not list (an llms.txt cut short), kept apart — unlisted, so its
      // excerpts carry no URL — with the sections after it, its
      // own headings; those before it are the last page's.
      for (const [k, page] of tail.entries()) {
        if (opens[k]) {
          flush();
          run = { base: page, parts: [], unlisted: true };
        } else mergeInto(run as unknown as Run, page);
      }
      flush();
    } else {
      // No page openings to go by: a few are the last page's own headings;
      // more are pages its index does not list, kept apart, rather than
      // served as one huge last page.
      if (tail.length <= MAX_TRAILING_HEADINGS) for (const page of tail) mergeInto(run as unknown as Run, page);
      flush();
      if (tail.length > MAX_TRAILING_HEADINGS) {
        for (const page of tail) {
          run = { base: page, parts: [], unlisted: true };
          flush();
        }
      }
    }
    // Every listed page found, in order — otherwise this is version skew.
    return next === entries.length ? merged : pages;
  }

  if (pages.length >= entries.length) return pages;
  const result = [...pages];
  const have = countTitles(result.map((p) => p.title));
  for (const entry of entries) {
    if ((have.get(entry.title) ?? 0) >= (wanted.get(entry.title) as number)) continue;
    const boundary = new RegExp(`\\n---\\n+### ${escapeRegExp(entry.title)}[ \\t]*(?:\\n|$)`);
    for (let i = 0; i < result.length; i++) {
      const page = result[i] as FullTextSection;
      const match = boundary.exec(page.body);
      if (!match) continue;
      const rest = page.body.slice(match.index + match[0].length).trim();
      result[i] = newSection(page.title, page.body.slice(0, match.index).trimEnd(), page.source);
      result.splice(i + 1, 0, newSection(entry.title, rest, page.source));
      have.set(entry.title, (have.get(entry.title) ?? 0) + 1);
      break;
    }
  }
  return result;
}

/**
 * How surely a section starts the way a page of the export does: 2 with its
 * "Last updated:" line, 1 by saying what its index entry's description says
 * (its first 40 characters), 0 neither.
 */
function pageOpening(section: FullTextSection, entry: DocEntry): number {
  if (startsPage(section)) return 2;
  const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const description = normalize(entry.description).slice(0, 40);
  return description.length > 0 && normalize(section.body.slice(0, 1_500)).includes(description) ? 1 : 0;
}

/**
 * Whether a section is a page of its own by what it holds, never a page's
 * own `---` + `###` heading: it opens with the "Last updated:" line the
 * export starts each article with (after the banner image of an SDK's front
 * page), or it lists other pages as cards — "#### [Title](/docs/…)" or an
 * image linking to one — as the category pages, which have no date, do.
 * 776 of the 781 pages on 12 October 2026 show one or the other. A heading
 * of a page that lists only the pages beside it as cards (a "See also") is
 * told apart by reconcilePages, which knows the page before it (opensApart).
 *
 * Of the other 5, four migration guides are told by their titles, numbers
 * of a series the index lists (see opensApart). What the files cannot tell
 * apart is decided one way, on purpose (no live case on that date): a dropped
 * page that shows none of that (a requirements page) is merged as a heading
 * into the page before it, and more than MAX_TRAILING_HEADINGS of the last
 * page's own headings are kept apart as unlisted pages. Each costs a page
 * its URL or a heading its page, never any text.
 */
export function startsPage(section: Pick<FullTextSection, 'body'>): boolean {
  return LAST_UPDATED.test(section.body) || cardPaths(section.body).length > 0;
}

/** The "Last updated:" line the export starts each article with, after the banner image of an SDK's front page. */
const LAST_UPDATED = /^(?:!\[[^\]]*\]\([^)]*\)\s*)?Last updated:/;

/** The pages a section lists as cards: "#### [Title](/docs/…)", or an image linking to one. */
function cardPaths(body: string): string[] {
  return [
    ...body.matchAll(/^#### \[[^\]]*\]\((\/docs\/[^)\s]*)\)/gm),
    ...body.matchAll(/\[!\[[^\]]*\]\([^)]*\)\]\((\/docs\/[^)\s]*)\)/g),
  ].map((m) => m[1] as string);
}

/**
 * Whether a section the index does not list opens like a page of its own
 * rather than as the page before it's own heading: by what it holds
 * (startsPage), or by its title, another number of a series the index lists
 * ("Migrate to 3.1.4" beside "Migrate to 3.1.3": the migration guides have
 * neither a date nor cards), as no page's own heading is. A list of page
 * cards is a category page — unless every card links to a page in the
 * folder of the page before (a "See also" of the pages beside it), or none
 * links to the page the index lists next (a "See also" of pages elsewhere),
 * which no category page does: its cards are its own pages, which the index
 * lists right after it (on 12 October 2026, all 87 pages with cards are
 * followed by one of their cards, and none lists only pages from the folder
 * of the page before it). `before` and `after` are the index entries of the
 * pages before and after it: undefined when the page before is unlisted
 * too, so nothing says where it lives, or when no listed page follows.
 */
function opensApart(
  section: FullTextSection,
  before: DocEntry | undefined,
  after: DocEntry | undefined,
  entries: DocEntry[]
): boolean {
  if (!startsPage(section)) return ofListedSeries(section.title, entries);
  if (before === undefined || LAST_UPDATED.test(section.body)) return true;
  const cards = cardPaths(section.body);
  const folder = folderOf(before.path);
  if (cards.every((card) => folderOf(card) === folder)) return false;
  return after === undefined || cards.includes(after.path);
}

/** A title's series: the title with each version number in it ("3.1.4", "v2.27") as "#"; undefined without one. */
function seriesOf(title: string): string | undefined {
  const series = title.replace(/\bv?\d+(?:\.\d+)+\b/gi, '#');
  return series === title ? undefined : series;
}

/**
 * Whether a title the index does not list is another number of a series it
 * lists ("Migrate to 3.1.4" beside "Migrate to 3.1.3"). A listed title is its
 * own page's: a section titled so right before that page is the heading of
 * the page before ("### Migrate to 3.1.4" closing Migrate to 3.1.3).
 */
function ofListedSeries(title: string, entries: DocEntry[]): boolean {
  const series = seriesOf(title);
  return (
    series !== undefined && entries.every((e) => e.title !== title) && entries.some((e) => seriesOf(e.title) === series)
  );
}

/** The folder of a documentation path: "/docs/android/examples/" for "/docs/android/examples/routing.md". */
function folderOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/') + 1);
}

/** A page being reassembled from the sections the split made of it. */
interface Run {
  base: FullTextSection;
  parts: string[];
  /** A page the index does not list, kept apart: it gets no URL, even when a listed page shares its title. */
  unlisted?: boolean;
}

/** Pages a repair kept apart as unlisted (see reconcilePages); attachUrls gives them no URL. */
const KEPT_APART = new WeakSet<FullTextSection>();

/**
 * How many unlisted sections after the last listed page are still taken for
 * that page's own `---` + `###` headings. More is an index that stops short
 * of the page contents.
 */
const MAX_TRAILING_HEADINGS = 3;

function mergeInto(run: Run, page: FullTextSection): void {
  if (run.parts.length === 0) run.parts.push(run.base.body);
  run.parts.push(`### ${page.title}\n\n${page.body}`.trim());
}

function countTitles(titles: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of titles) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

function newSection(title: string, body: string, source: string): FullTextSection {
  const bodyLower = body.toLowerCase();
  return {
    title,
    body,
    source,
    titleLower: title.toLowerCase(),
    bodyLower,
    titleWords: new Set(tokenize(title)),
    words: wordStats(bodyLower, source),
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Why a page-contents file that downloaded fine still counts as not loaded. */
export const EMPTY_FULL_TEXT_REASON =
  'the file holds no pages (an empty file, or not in the expected llms-full.txt format)';

const sectionMemo = new SourceMemo<FullTextSection[]>((body, sourceId) => {
  const sections = splitFullText(body, sourceId);
  // No pages at all is a broken file, never a source without documentation:
  // reported as a failed load, so it cannot read as "nothing found" or
  // "nothing updated".
  if (sections.length === 0) throw new Error(EMPTY_FULL_TEXT_REASON);
  return sections;
});

/**
 * Page lists reconciled with their index, per downloaded page list: the repair
 * is redone when the index changes (its entry objects are new), never when a
 * 304 keeps both as they were.
 */
const reconciled = new WeakMap<FullTextSection[], { key: DocEntry; pages: FullTextSection[] }>();

export interface FullTextLoad {
  sections: FullTextSection[];
  /** Sources whose page contents could not be loaded. */
  failed: SourceFailure[];
  /** Sources whose pages loaded but whose index did not: those pages carry no URL. */
  unlinked: SourceFailure[];
}

/**
 * Load (and memoize) the pages of every requested source that publishes
 * llms-full.txt. Raw multi-megabyte bodies are NOT kept: only the parsed
 * pages are stored, together with the upstream ETag/Last-Modified, and a
 * refresh that fails keeps serving the previous pages. Each page is joined to
 * its index entry so hits can carry a URL. A caller that has already started
 * loading the index passes it in, so one call never loads it twice; the page
 * contents download meanwhile.
 */
export async function loadFullTextSections(
  sourceIds?: string[],
  index: Promise<IndexLoad> | IndexLoad = loadIndex(sourceIds)
): Promise<FullTextLoad> {
  const sources = DOCS.sources.filter(
    (s) => s.fullTextUrl && (!sourceIds || sourceIds.length === 0 || sourceIds.includes(s.id))
  );
  const sections: FullTextSection[] = [];
  const failed: SourceFailure[] = [];
  const unlinked: SourceFailure[] = [];
  const results = await Promise.allSettled(
    sources.map((source) => sectionMemo.load(source.id, source.fullTextUrl as string))
  );
  const { entries, failed: indexFailed } = await index;
  results.forEach((result, i) => {
    const source = (sources[i] as DocSource).id;
    if (result.status === 'rejected') {
      failed.push(sourceFailure(source, 'full-text', result.reason));
      return;
    }
    let pages = result.value;
    const own = entries.filter((e) => e.source === source);
    if (own.length > 0) {
      const key = own[0] as DocEntry;
      const cached = reconciled.get(pages);
      if (cached?.key === key) pages = cached.pages;
      else {
        const repaired = reconcilePages(pages, own);
        // A new index version may have moved pages: always re-link against it.
        attachUrls(repaired, own);
        reconciled.set(pages, { key, pages: repaired });
        pages = repaired;
      }
    }
    const indexFailure = indexFailed.find((f) => f.source === source);
    if (indexFailure) unlinked.push(indexFailure);
    sections.push(...pages);
  });
  return { sections, failed, unlinked };
}

/**
 * The pages of one source as held in memory, fresh or stale, without a
 * download — joined to their index as the last load joined them; undefined
 * before the first load.
 */
export function peekFullTextSections(sourceId: string): FullTextSection[] | undefined {
  const pages = sectionMemo.peek(sourceId);
  return pages && (reconciled.get(pages)?.pages ?? pages);
}

/** Full-text files whose last download failed recently (see SourceMemo.failing). */
export function failingFullTexts(): ReturnType<SourceMemo<FullTextSection[]>['failing']> {
  return sectionMemo.failing();
}

/** Section-memo statistics for observability (/health, diagnostics). */

export function fullTextStats(): { sources: number; sections: number } {
  let sections = 0;
  for (const pages of sectionMemo.loaded().values()) sections += pages.length;
  return { sources: sectionMemo.loaded().size, sections };
}

/** Exposed for tests. */
export function clearFullTextCache(): void {
  sectionMemo.clear();
}

/** Exposed for tests: install parsed pages for a source directly, bypassing the network. */
export function seedFullTextSections(sourceId: string, content: string): void {
  sectionMemo.seed(sourceId, content);
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The first position of the exact `phrase` in `text` between word boundaries, or -1. */
function findPhrase(text: string, phrase: string): number {
  let idx = text.indexOf(phrase);
  while (idx !== -1) {
    const before = idx === 0 ? '' : (text[idx - 1] as string);
    const after = idx + phrase.length >= text.length ? '' : (text[idx + phrase.length] as string);
    // Whole words only — a trailing "s" still counts ("add marker" in "add markers").
    if (!/[a-z0-9]/.test(before) && (after === 's' || !/[a-z0-9]/.test(after))) return idx;
    idx = text.indexOf(phrase, idx + phrase.length);
  }
  return -1;
}

/**
 * Full-text search across pages. Returns excerpts centred on the first match
 * of each page; whole words only, rare words weigh more, and a page whose
 * title carries the query phrase ranks first.
 */
export function searchFullText(
  sections: FullTextSection[],
  query: string,
  limit: number,
  excerptChars = 700,
  indexRank: ReadonlyMap<string, number> = new Map(),
  prefer?: PlatformPreference
): FullTextHit[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  const phrase = query.trim().toLowerCase();
  // As in the index ranking: a word such as "cloud" in "cloud geocoding"
  // leans towards its platform's pages and weighs little itself.
  const softWords = new Set(tokenize((prefer?.words ?? []).join(' ')));
  const preferred = new Set(prefer?.sources ?? []);

  const weight = new Map<string, number>();
  for (const token of tokens) {
    let df = 0;
    for (const s of sections) if (s.words.has(token)) df++;
    const idf = 1 + Math.log((sections.length + 1) / (df + 1));
    weight.set(token, softWords.has(token) ? idf / 4 : idf);
  }

  // Where each hit first meets a query word: a sort key for equal scores.
  const firstMatch = new Map<FullTextHit, number>();
  const hits: FullTextHit[] = [];
  for (const section of sections) {
    let score = 0;
    let anchor = -1;
    let first = Number.MAX_SAFE_INTEGER; // only title words matched

    for (const token of tokens) {
      const w = weight.get(token) as number;
      if (section.titleWords.has(token)) score += 5 * w;
      const packed = section.words.get(token);
      if (packed !== undefined) {
        const hit = wordHit(packed);
        if (anchor === -1) anchor = hit.first;
        first = Math.min(first, hit.first);
        score += hit.count * w;
      }
    }
    if (phrase.length > 3) {
      const inBody = findPhrase(section.bodyLower, phrase);
      if (inBody !== -1) {
        score += 15;
        anchor = inBody;
      }
      if (findPhrase(section.titleLower, phrase) !== -1) score += 15;
    }

    if (score <= 0) continue;
    // The platform the query leans towards, on its pages about the topic —
    // a title naming a topic word ("Markers" for "compose markers") — not on
    // every page of it that mentions a word ("Isochrones API" for "rest area").
    if (preferred.has(section.source) && topicInTitle(section.titleWords, tokens, softWords)) {
      score *= PREFERRED_SOURCE_BOOST;
    }

    // Never cut inside a surrogate pair (an emoji) at either end of the window.
    let start = Math.max(0, (anchor === -1 ? 0 : anchor) - Math.floor(excerptChars / 3));
    if (start > 0 && isLowSurrogate(section.body.charCodeAt(start))) start--;
    let end = Math.min(section.body.length, start + excerptChars);
    if (end < section.body.length && isLowSurrogate(section.body.charCodeAt(end))) end--;
    const excerptRaw = section.body.slice(start, end);
    const excerpt = (start > 0 ? '…' : '') + excerptRaw.trim() + (end < section.body.length ? '…' : '');

    const hit = { title: section.title, source: section.source, url: section.url, path: section.path, excerpt, score };
    hits.push(hit);
    firstMatch.set(hit, first);
  }

  // Long pages reach the per-word count cap alike, so equal scores are
  // common. Among them, the page the index ranks higher for the query comes
  // first (`indexRank`, path → position: its title and description say what
  // the page is about), then the page that brings the query up earliest,
  // and only then the alphabet.
  const pathKey = (hit: FullTextHit): string => hit.path ?? '';
  const ranked = (hit: FullTextHit): number => indexRank.get(pathKey(hit)) ?? Number.MAX_SAFE_INTEGER;
  const firstAt = (hit: FullTextHit): number => firstMatch.get(hit) as number;
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      ranked(a) - ranked(b) ||
      firstAt(a) - firstAt(b) ||
      a.title.localeCompare(b.title) ||
      pathKey(a).localeCompare(pathKey(b))
  );
  return hits.slice(0, limit);
}
