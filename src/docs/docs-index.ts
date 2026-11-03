/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The llms.txt index: parsing, URL-derived sections, and word-based ranking.
 */

import type { DocSource } from '../config/constants.js';
import { DOCS, LIMITS, isAllowedDocUrl } from '../config/constants.js';
import { SourceMemo, sourceFailure } from './source-memo.js';
import type { SourceFailure } from './source-memo.js';

export interface DocEntry {
  /** Page title from the llms.txt index. */
  title: string;
  /** Absolute URL of the page (a .md endpoint). */
  url: string;
  /** Pathname of the page, e.g. /docs/flutter/examples/maps-3dscene/add-markers.md */
  path: string;
  /** Short description from the index, if any. */
  description: string;
  /**
   * Section derived from the page's location, e.g. "Examples › Maps & 3D
   * Scene". The published indexes carry no headings below "## Docs", so the
   * URL is the only structure there is; category pages lend their titles.
   */
  section: string;
  /** Source id ("developer", "flutter", ...). */
  source: string;
}

/**
 * Parse an llms.txt index. Entry shape (tolerant to variations):
 *
 *   - [Title](/docs/path/page.md): optional description
 */
export function parseLlmsTxt(content: string, source: DocSource): DocEntry[] {
  const items: Array<Omit<DocEntry, 'section'>> = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const item = rawLine.trim().match(/^[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)\s*(?::\s*(.*))?$/);
    if (!item) continue;

    // Groups 1 (title) and 2 (href) are guaranteed present by the match.
    const url = toAbsoluteUrl(item[2] as string);
    // Only surface entries that point at the documentation host itself. A link
    // injected upstream would otherwise reach the agent as a plausible-looking
    // foreign URL (and fetching it is blocked downstream anyway).
    if (!isAllowedDocUrl(url)) continue;
    items.push({
      title: (item[1] as string).trim(),
      url,
      path: new URL(url).pathname,
      description: (item[3] ?? '').trim(),
      source: source.id,
    });
  }

  const titleByPath = new Map(items.map((e) => [e.path, e.title]));
  const root = sourceRoot(source);
  return items.map((e) => ({ ...e, section: deriveSection(e.path, root, titleByPath) }));
}

/** The path prefix every page of a source lives under, e.g. /docs/flutter/. */
export function sourceRoot(source: DocSource): string {
  return new URL(source.indexUrl).pathname.replace(/llms\.txt$/, '');
}

/**
 * "Examples › Maps & 3D Scene" for /docs/flutter/examples/maps-3dscene/add-markers.md:
 * one label per directory below the source root, using the category page's
 * own title when the index lists it and a prettified slug otherwise.
 */
export function deriveSection(path: string, root: string, titleByPath: Map<string, string>): string {
  const relative = path.startsWith(root) ? path.slice(root.length) : path.replace(/^\//, '');
  const segments = relative.split('/');
  segments.pop(); // the page itself
  const labels: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const categoryPath = `${root}${segments.slice(0, i + 1).join('/')}.md`;
    labels.push(titleByPath.get(categoryPath) ?? prettifySlug(segments[i] as string));
  }
  return labels.join(' › ');
}

function prettifySlug(slug: string): string {
  return slug
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Resolve a relative docs path against the Magic Lane developer site. */
export function toAbsoluteUrl(href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  return `${DOCS.baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
}

const indexMemo = new SourceMemo<DocEntry[]>(
  (body, sourceId) => {
    const entries = parseLlmsTxt(body, DOCS.sources.find((s) => s.id === sourceId) as DocSource);
    // No pages at all is a broken file, never a source without documentation:
    // a failed load, so it is reported and /ready does not count it as loaded.
    if (entries.length === 0) throw new Error(EMPTY_INDEX_REASON);
    return entries;
  },
  { keepText: true }
);

/** What an index load produced: the entries that could be read, and who failed. */
export interface IndexLoad {
  entries: DocEntry[];
  failed: SourceFailure[];
}

/** The sources a tool asked for: all of them when the list is empty or absent. */
export function selectSources(sourceIds?: string[]): DocSource[] {
  return DOCS.sources.filter((s) => !sourceIds || sourceIds.length === 0 || sourceIds.includes(s.id));
}

/** Why an index that downloaded fine still counts as not loaded. */
export const EMPTY_INDEX_REASON = 'the index lists no pages (an empty file, or not in the expected llms.txt format)';

/**
 * Load the llms.txt indexes for the requested sources. A source that cannot
 * be fetched — or whose index parses to no pages at all, which is a broken
 * or changed file, never a source without documentation — is reported in
 * `failed` rather than silently dropped, so a network problem never reads as
 * "Magic Lane does not document this".
 */
export async function loadIndex(sourceIds?: string[]): Promise<IndexLoad> {
  const sources = selectSources(sourceIds);
  const entries: DocEntry[] = [];
  const failed: SourceFailure[] = [];
  const results = await Promise.allSettled(sources.map((source) => indexMemo.load(source.id, source.indexUrl)));
  results.forEach((result, i) => {
    const source = (sources[i] as DocSource).id;
    if (result.status === 'rejected') failed.push(sourceFailure(source, 'index', result.reason));
    else entries.push(...result.value);
  });
  return { entries, failed };
}

/**
 * One source's llms.txt as downloaded — the MCP resource — from the same
 * memo the tools read, so a file is downloaded once for both, and a
 * cancelled request stops waiting for it.
 */
export function indexText(sourceId: string): Promise<string> {
  const source = DOCS.sources.find((s) => s.id === sourceId) as DocSource;
  return indexMemo.loadText(source.id, source.indexUrl);
}

/** Index files whose last download failed recently (see SourceMemo.failing). */
export function failingIndexes(): ReturnType<SourceMemo<DocEntry[]>['failing']> {
  return indexMemo.failing();
}

/** The index of one source as held in memory, fresh or stale, without a download; undefined before its first load. */
export function peekIndex(sourceId: string): DocEntry[] | undefined {
  return indexMemo.peek(sourceId);
}

/** How many sources' indexes are loaded (fresh or stale): 0 means search cannot answer at all. */
export function loadedIndexCount(): number {
  return indexMemo.loadedCount();
}

/** Exposed for tests: forget memoized indexes so fixtures can be replaced. */
export function clearIndexCache(): void {
  indexMemo.clear();
}

/** Exposed for tests: install an index for a source without any network. */
export function seedIndex(sourceId: string, content: string): void {
  indexMemo.seed(sourceId, content);
}

/* -------------------------------------------------------------------------- */
/* Ranking                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Words that carry no signal in this corpus: English function words and
 * "docs" itself. The product name is NOT one: "what is Magic Lane" must find
 * the pages that introduce it (inverse document frequency already keeps a
 * word that many pages share from dominating).
 */
const STOPWORDS = new Set([
  ...['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'how'],
  ...['i', 'in', 'into', 'is', 'it', 'me', 'us', 'my', 'of', 'on', 'or', 'our', 'the', 'to', 'use'],
  ...['using', 'via', 'we', 'what', 'when', 'where', 'which', 'with', 'you', 'your'],
  ...['there', 'this', 'that', 'these', 'those', 'any', 'some', 'have', 'has', 'had', 'should'],
  ...['would', 'could', 'will', 'if', 'than', 'then', 'but', 'also', 'just'],
  ...['docs', 'doc', 'documentation', 'vs', 'versus'],
  // How people phrase a question, not what it is about: "what is the best
  // way to add markers", "is it possible to …", "please help me …". Rare in
  // the index, they would otherwise outweigh the topic.
  ...['best', 'way', 'ways', 'possible', 'need', 'needs', 'want', 'wants', 'please', 'help', 'recommended'],
  ...['recommend', 'difference', 'differences', 'able', 'tell', 'know', 'explain', 'like', 'correct', 'right'],
  ...['am', 'try', 'trying', 'tried', 'easiest', 'easy', 'simplest', 'quickest', 'looking', 'wondering', 'anyone'],
]);

/**
 * Words whose -ing/-ed form is a word of its own here: "the following",
 * "get started", "settings", "string". Folding them would merge unrelated
 * pages ("follow position" matching every "the following").
 */
const KEEP_ENDING = new Set([
  ...['following', 'started', 'setting', 'string', 'during', 'nothing', 'something', 'anything'],
  ...['everything', 'ceiling', 'interested', 'proceed', 'exceed', 'succeed'],
]);

/**
 * Forms of one word this corpus uses for the same thing, folded to one: the
 * setup guides say "install", people ask for "installation".
 */
const SAME_AS: Readonly<Record<string, string>> = Object.assign(Object.create(null) as Record<string, string>, {
  installation: 'instal', // the stem of "install"
  // The noun and its verb: "route calculation" finds "Calculate Route".
  // cspell:ignore simulat calculat optimiz configur
  simulation: 'simulat',
  calculation: 'calculat',
  optimization: 'optimiz',
  configuration: 'configur',
  // cspell:ignore integrat navigat animat rotat
  integration: 'integrat',
  navigation: 'navigat',
  rotation: 'rotat',
  selection: 'select',
  animation: 'animat',
  // cspell:ignore activat localiz
  activation: 'activat',
  localization: 'localiz',
  // Not "projection": developers say "project" for their app or account
  // project ("add the SDK to my project"), rarely for coordinate projections.
  directions: 'direct',
  direction: 'direct',
  // The tool and its verb: "record a route" finds the Recorder.
  recorder: 'record',
  simulator: 'simulat',
});

/**
 * Another word for the same thing, folded into it like a form of it: the
 * SDK guides call the credential an "API token", the account guide an "API
 * key". Apart from SAME_AS because it is another word: a description that
 * says "key" ("key concepts") does not name the token as asked (see
 * ScoredEntry.rarestNamedEarly).
 */
const SYNONYMS: Readonly<Record<string, string>> = Object.assign(Object.create(null) as Record<string, string>, {
  token: 'key',
});

/**
 * Action words and page-type words that say little about the topic: "add
 * markers" is about markers. They count half, and are never "the most
 * specific word" of a query that has any other.
 */
const GENERIC_WORDS: ReadonlySet<string> = new Set(
  // Stemmed like every word they are compared with.
  [
    ...['add', 'create', 'get', 'set', 'show', 'display', 'make', 'build', 'implement', 'enable'],
    // "upgrade to 3.1.4" asks for the migration guide of 3.1.4, which says
    // "migrate" and "update", never "upgrade".
    ...['change', 'update', 'upgrade', 'remove', 'handle', 'start', 'run', 'find', 'see', 'view', 'work'],
    ...['apply', 'configure', 'customize', 'example', 'guide', 'tutorial', 'sample'],
    // "SDK" is in most descriptions ("Maps SDK for …"): it says which product,
    // not which page ("flutter sdk routing" is about routing).
    ...['sdk', 'sdks'],
  ].map((w) => stem(w))
);

/**
 * Fold inflections so "markers" finds "Add Marker", "addresses" finds
 * "Address Search", "routing" and "calculated" find "Calculate Route". Query
 * words and page words (index fields AND page text, see full-text.ts) all go
 * through this one function, so it only has to be consistent, not
 * linguistically exact: route, routes, routed and routing all become "rout".
 * The order matters — plural, then -ing/-ed, then a doubled consonant, then a
 * trailing e — so "styles" and "style" both end the same way.
 */
export function stem(word: string): string {
  const own = ownStem(word);
  return SYNONYMS[own] ?? own;
}

/** The stem of a word as written: its forms folded (see stem), but not into another word (SYNONYMS). */
function ownStem(word: string): string {
  // A version: "v3.1.4" is 3.1.4, and "3.1" is 3.1.0 — a trailing ".0" says
  // nothing (one dot stays: 3.0.0 is "3.0", not the number 3).
  if (/^v?\d+(?:\.\d+)+$/.test(word)) return word.replace(/^v/, '').replace(/(?<=\d\.\d+(?:\.\d+)*)(?:\.0)+$/, '');
  if (word.length <= 3) return SAME_AS[word] ?? word;
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(?:ss|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (SAME_AS[w]) return SAME_AS[w] as string;
  if (KEEP_ENDING.has(w)) return w;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 3 && /([b-df-hj-np-rtv-z])\1$/.test(w)) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/**
 * The words of this corpus: a dotted version number as one word ("3.1.4",
 * "v3.1.4" or "V3.1.4", whose one-digit parts would otherwise be dropped), or
 * letters and digits of any script, plus the "+" and "#" of C++ and C#.
 * Index text is lower-cased before it is split; a query is split as written.
 */
const WORD = /[vV]?\d+(?:\.\d+)+|[\p{L}\p{N}+#]+/gu;

/**
 * The own stem (see ownStem) of a word of running text, given the word
 * before it. "the following" introduces a list, and keeps its own stem; any
 * other "following" is the verb ("following the position" finds "Follow
 * Position").
 */
function ownStemInText(raw: string, before: string): string {
  return raw === 'following' && before !== 'the' ? 'follow' : ownStem(raw);
}

/**
 * A request verb before "me" or "us" — "could you show me how to …", "give me
 * an example of …", "walk me through …" — says how the question is put, not
 * what it is about: unlike "show traffic", where "show" is the action asked
 * for. The verb goes, and the "through" of "walk me through"; its "me" or
 * "us" is a stopword anyway.
 */
const REQUEST = /\b(?:show|give|walk|teach|point)(?=\s+(?:me|us)\b)|(?<=\bwalk\s+(?:me|us)\s+)through\b/gu;

/** A lower-cased text without its request verbs (see REQUEST). */
function withoutRequests(lower: string): string {
  return lower.replace(REQUEST, '');
}

/** The end of a sentence: a full stop, question or exclamation mark before a space or the end ("3.1.4" has none). */
const SENTENCE_END = /[.!?](?=\s|$)/gu;

/**
 * Every stemmed, stopword-free word of a text, in order, repeats included,
 * each also by its own stem (as written, see ownStem: "token", not "key") and
 * with the sentence it stands in (the first is 0): a page about a thing
 * names it in its first sentence, one that mentions it in passing later on.
 */
function sequence(text: string): Array<{ word: string; own: string; sentence: number }> {
  const lower = withoutRequests(text.toLowerCase());
  const ends = [...lower.matchAll(SENTENCE_END)].map((m) => m.index);
  const words: Array<{ word: string; own: string; sentence: number }> = [];
  let before = '';
  let sentence = 0;
  for (const match of lower.matchAll(WORD)) {
    const raw = match[0];
    const previous = before;
    before = raw;
    while (sentence < ends.length && (ends[sentence] as number) < match.index) sentence++;
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    const own = ownStemInText(raw, previous);
    words.push({ word: SYNONYMS[own] ?? own, own, sentence });
  }
  return words;
}

/** Every stemmed, stopword-free word of a text, in order, repeats included. */
function wordSequence(text: string): string[] {
  return sequence(text).map((w) => w.word);
}

/** Every stopword-free word of a text as written (lower-cased), joined by spaces. */
function surfaceKey(text: string): string {
  const words: string[] = [];
  for (const [raw] of withoutRequests(text.toLowerCase()).matchAll(WORD)) {
    if (raw.length >= 2 && !STOPWORDS.has(raw)) words.push(raw);
  }
  return words.join(' ');
}

/** Whether two surface keys (see surfaceKey) are the same words, but for a plural "s" or "es". */
function sameWords(a: string, b: string): boolean {
  const x = a.split(' ');
  const y = b.split(' ');
  const plural = (p: string, q: string): boolean => p === `${q}s` || p === `${q}es`;
  return (
    x.length === y.length && x.every((w, i) => w === y[i] || plural(w, y[i] as string) || plural(y[i] as string, w))
  );
}

/** The own stems (see ownStem) of the query words that stem to `stem`: "token" for "key". */
function writtenAs(query: string, stem: string): string[] {
  return sequence(query)
    .filter((w) => w.word === stem)
    .map((w) => w.own);
}

/** Adjacent pairs of stemmed, stopword-free words ("calculate a route" → the stems of "calculate" and "route"). */
function wordPairs(words: string[]): Set<string> {
  return new Set(words.slice(1).map((w, i) => `${words[i]} ${w}`));
}

/** A word sequence as a string a phrase can be looked up in, word-bounded at both ends. */
function phraseKey(words: string[]): string {
  return ` ${words.join(' ')} `;
}

/**
 * The family of a version with a patch number, the versions its first two
 * numbers begin: "1.1.*" for 1.1.2. A query for a version no page names
 * ("v1.1.x breaking changes", and there is no 1.1.0) stands for its family
 * (see searchIndex).
 */
function familyOf(word: string): string | undefined {
  const version = /^(\d+\.\d+)\.\d+(?:\.\d+)*$/.exec(word);
  return version ? `${version[1]}.*` : undefined;
}

/** Words with the family of each version among them (see familyOf) after it. */
function withFamilies(words: readonly string[]): string[] {
  return words.flatMap((w) => {
    const family = familyOf(w);
    return family === undefined ? [w] : [w, family];
  });
}

/** Distinct, stemmed, stopword-free words of a text, in order of appearance. */
export function tokenize(text: string): string[] {
  return [...new Set(wordSequence(text))];
}

/**
 * Where each stemmed word occurs in a text: how often (capped at 10, so a long
 * page cannot win on repetition alone) and the
 * offset of its first occurrence, packed into one number (`first * 16 +
 * count`). Computed once per page at load, so a query costs one map lookup per
 * word instead of a scan of every page. Keys are interned: the ~20k distinct
 * stems of the corpus are shared by all pages instead of being one substring
 * per page each.
 */
export type WordStats = Map<string, number>;

/** Occurrences of one word counted per page. */
const MAX_WORD_COUNT = 10;

/** The words of one documentation source, each string shared by that source's pages. */
export type InternTable = Map<string, string>;

/**
 * The intern table of each source: the current parse's, replaced whole
 * when the source is parsed again, so the words of a copy that was dropped
 * go with it instead of staying for the life of the process.
 */
const internTables = new Map<string, InternTable>();

/** A fresh intern table for a parse of `source`, in place of the one before. */
export function newInternTable(source: string): InternTable {
  const table: InternTable = new Map();
  internTables.set(source, table);
  return table;
}

function intern(table: InternTable, word: string): string {
  const known = table.get(word);
  if (known !== undefined) return known;
  // A fresh string, not a slice of the page it came from.
  const own = `${word}`;
  table.set(own, own);
  return own;
}

/** The word statistics of a page of `source` (its current intern table; a table of its own without one). */
export function wordStats(text: string, source?: string): WordStats {
  const table = (source === undefined ? undefined : internTables.get(source)) ?? new Map<string, string>();
  const stats: WordStats = new Map();
  let before = '';
  for (const match of text.toLowerCase().matchAll(WORD)) {
    const raw = match[0];
    const previous = before;
    before = raw;
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    const own = ownStemInText(raw, previous);
    const word = intern(table, SYNONYMS[own] ?? own);
    const packed = stats.get(word);
    if (packed === undefined) stats.set(word, match.index * 16 + 1);
    else if ((packed & 15) < MAX_WORD_COUNT) stats.set(word, packed + 1);
  }
  return stats;
}

/** Unpack one entry of {@link wordStats}. */
export function wordHit(packed: number): { count: number; first: number } {
  return { count: packed & 15, first: Math.floor(packed / 16) };
}

/**
 * Words that name a documentation source. In a query they say where to look,
 * not what for: "get started flutter" means the Flutter get-started page.
 */
export const PLATFORM_WORDS: Readonly<Record<string, string>> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    flutter: 'flutter',
    dart: 'flutter',
    android: 'android',
    kotlin: 'android',
    java: 'android',
    compose: 'android',
    ios: 'ios',
    swift: 'ios',
    swiftui: 'ios',
    uikit: 'ios',
    objc: 'ios',
    cpp: 'cpp',
    'c++': 'cpp',
    typescript: 'typescript',
    javascript: 'typescript',
    ts: 'typescript',
    js: 'typescript',
    web: 'typescript',
    react: 'typescript',
    cloud: 'cloud-rest-api',
    rest: 'cloud-rest-api',
  }
);

/**
 * Platform words that are everyday words too: "web" in "map studio web
 * editor", "cloud" in "cloud account api key", "react" in "react to route
 * events". They name a platform only next to a qualifier ("web SDK", "REST
 * API", "cloud APIs") or another word for the same platform ("cloud REST").
 */
const AMBIGUOUS_PLATFORM_WORDS: ReadonlySet<string> = new Set(['web', 'cloud', 'rest', 'react', 'compose']);
/**
 * Of those, the ones that lean towards their platform even without a
 * qualifier (see platformPreference). Not "react": "react to route events"
 * is a verb, and rarely means the platform.
 */
const PREFERENCE_WORDS: ReadonlySet<string> = new Set(['web', 'cloud', 'rest', 'compose']);
const PLATFORM_QUALIFIERS: ReadonlySet<string> = new Set(['sdk', 'sdks', 'api', 'apis']);

/** The source the `i`-th query word names, if it names one (see AMBIGUOUS_PLATFORM_WORDS). */
function platformAt(words: readonly string[], i: number): string | undefined {
  const word = (words[i] as string).toLowerCase();
  const platform = PLATFORM_WORDS[word];
  if (platform === undefined || !AMBIGUOUS_PLATFORM_WORDS.has(word)) return platform;
  const qualifies = (neighbor: string | undefined): boolean =>
    neighbor !== undefined &&
    (PLATFORM_QUALIFIERS.has(neighbor.toLowerCase()) || PLATFORM_WORDS[neighbor.toLowerCase()] === platform);
  return qualifies(words[i - 1]) || qualifies(words[i + 1]) ? platform : undefined;
}

/** Where a query asks to look, and what for. */
export interface PlatformScope {
  /** The query without the platform words that only say where to look. */
  topic: string;
  /** The sources the query names; empty when it names none (search everything). */
  sources: string[];
}

/** A query word that says nothing about the topic: a stopword, or an SDK/API qualifier ("flutter sdk"). */
function saysNothing(word: string): boolean {
  const w = word.toLowerCase();
  return STOPWORDS.has(w) || PLATFORM_QUALIFIERS.has(w);
}

/**
 * The sources a query names, in query order — where to look ("get started
 * flutter": the Flutter pages); empty when it names none. Decided from the
 * words alone, so a search can download the right sources at once;
 * {@link platformScope} then settles the topic.
 */
export function platformSources(query: string): string[] {
  const words = rawQueryWords(query);
  return [...new Set(words.map((_, i) => platformAt(words, i)).filter((p): p is string => p !== undefined))];
}

/**
 * Split the platform names off a query: "get started flutter" is "get
 * started", searched in the Flutter pages only. Scoring "flutter" as a word
 * instead would favour pages whose description happens to say "Flutter" over
 * the page about the topic. A platform word stays in the topic when it is
 * part of a feature's name — next to another query word in some page title
 * ("Android Auto", "Swift Package Manager", "Route Simulation Java") — and
 * when nothing else is left: "C++", "what is flutter", "is there a flutter
 * sdk" and "ios vs android" are about the platforms themselves, so their
 * names are the search words, looked up in their own pages. `titles` are the
 * index titles that decide what counts as a feature name.
 */
export function platformScope(query: string, titles: readonly string[]): PlatformScope {
  const sources = platformSources(query);
  if (sources.length === 0) return { topic: query, sources };
  const words = rawQueryWords(query);
  const platforms = words.map((_, i) => platformAt(words, i));
  const others = words.filter((w, i) => platforms[i] === undefined && !saysNothing(w));
  if (others.length === 0) return { topic: query, sources };
  const lowerTitles = titles.map((t) => ` ${t.toLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, ' ')} `);
  // Compared as stems without stopwords, so "for flutter" names nothing:
  // every SDK has a "Maps SDK for <Platform>" page.
  const stemmedTitles = titles.map((t) => ` ${tokenize(t).join(' ')} `);
  // The query is a page's title ("maps sdk for flutter"): that page is the
  // topic, platform name and all, searched in its own source.
  if (stemmedTitles.includes(` ${tokenize(query).join(' ')} `)) return { topic: query, sources };
  // A qualifier next to the platform word ("flutter sdk", "sdk for flutter")
  // names the platform itself, never a feature.
  const named = (a: string | undefined, b: string | undefined): boolean => {
    if (a === undefined || b === undefined || saysNothing(a) || saysNothing(b)) return false;
    const pair = tokenize(`${a} ${b}`);
    return pair.length === 2 && stemmedTitles.some((t) => t.includes(` ${pair.join(' ')} `));
  };
  // A title with the platform word and every other word (two or more) of
  // the query: "java route simulation" is the page "GPX Route Simulation
  // Java". One other word is too little: "navigation android" is not
  // "Android Auto Navigation".
  const titled = (w: string): boolean =>
    others.length >= 2 && lowerTitles.some((t) => [w, ...others].every((x) => t.includes(` ${x.toLowerCase()} `)));
  const dropped = new Set<number>();
  words.forEach((w, i) => {
    if (platforms[i] === undefined) return;
    const before = platforms[i - 1] === undefined ? words[i - 1] : undefined;
    const after = platforms[i + 1] === undefined ? words[i + 1] : undefined;
    if (!(named(before, w) || named(w, after) || titled(w))) dropped.add(i);
  });
  // A dropped platform name takes its own qualifier and function words with
  // it ("flutter sdk routing", "routing with the android sdk"), so the topic
  // is the phrase the pages are searched for ("routing") — but only the words
  // next to it, and never the "API" of the credential's name ("flutter api
  // key" and "rest api key" ask for the API key). Any other "API" goes with
  // the platform's name, like "SDK": "routing api flutter" asks for routing,
  // and "api" would be a rare, heavy word there that lifts every page whose
  // description mentions an API over the routing guide.
  for (const i of [...dropped]) {
    for (const step of [-1, 1]) {
      for (let j = i + step; j >= 0 && j < words.length && saysNothing(words[j] as string); j += step) {
        if (apiPhrase(words, j)) break;
        dropped.add(j);
      }
    }
  }
  const keptAt = words.map((_, i) => i).filter((i) => !dropped.has(i));
  if (keptAt.length < words.length) {
    // Function words and qualifiers left at either end go too ("what flutter
    // routing is", "flutter routing api"), but not the credential's "API".
    const dangling = (i: number): boolean => saysNothing(words[i] as string) && !apiPhrase(words, i);
    while (keptAt.length > 1 && dangling(keptAt[0] as number)) keptAt.shift();
    while (keptAt.length > 1 && dangling(keptAt.at(-1) as number)) keptAt.pop();
  }
  return { topic: keptAt.map((i) => words[i]).join(' '), sources }; // never empty: a word of `others` is never dropped
}

/**
 * Whether the `i`-th query word is the "API" of the credential's name ("api
 * key", "api token"): a topic of its own, not a qualifier of a platform.
 */
function apiPhrase(words: readonly string[], i: number): boolean {
  if (!/^apis?$/i.test(words[i] as string)) return false;
  return [words[i - 1], words[i + 1]].some((w) => w !== undefined && tokenize(w)[0] === 'key');
}

/** Whether a query asks about the API key ("api key", "api token", "where do I get a rest api key"). */
export function namesApiKey(query: string): boolean {
  const words = rawQueryWords(query);
  return words.some((_, i) => apiPhrase(words, i));
}

/** A platform the query leans towards without asking to search only it. */
export interface PlatformPreference {
  /** The everyday-word platform names that say so ("cloud" in "cloud geocoding"). */
  words: string[];
  /** Their sources, whose pages rank higher. */
  sources: string[];
}

/**
 * Platform words that are everyday words too (PREFERENCE_WORDS) and name no
 * platform in this query on their own terms: "cloud geocoding", "web
 * markers", "compose navigation". They lean towards their platform without
 * excluding the others — its pages rank higher, and the word itself counts
 * as little as an action word — so "cloud geocoding" finds the Reverse
 * Geocode API rather than the "Cloud REST APIs" overview, and "rest area"
 * can still find rest areas wherever they are. A query that is nothing but
 * such a word ("cloud") keeps it as its search word: no preference.
 */
export function platformPreference(query: string): PlatformPreference {
  const words = rawQueryWords(query);
  const soft = words.filter((w, i) => PREFERENCE_WORDS.has(w.toLowerCase()) && platformAt(words, i) === undefined);
  const others = words.filter(
    (w) => !soft.includes(w) && !saysNothing(w) && PLATFORM_WORDS[w.toLowerCase()] === undefined
  );
  if (soft.length === 0 || others.length === 0) return { words: [], sources: [] };
  // Followed by a function word, the word is in a phrase of its own rather
  // than naming a platform ("rest of the route", "compose a message"): it
  // still weighs little, but leans towards no platform.
  const leaning = soft.filter((w) => !STOPWORDS.has((words[words.indexOf(w) + 1] ?? '').toLowerCase()));
  return {
    words: soft,
    sources: [...new Set(leaning.map((w) => PLATFORM_WORDS[w.toLowerCase()] as string))],
  };
}

/** How much higher a preferred platform's pages rank (see platformPreference). */
export const PREFERRED_SOURCE_BOOST = 1.5;

/**
 * Whether a page's title names a word of the topic — a query word other than
 * the platform word it leans by. The preference boost goes to those pages
 * only: "rest area" leans towards the Cloud REST APIs, but their Isochrones
 * page, which mentions areas, is no page about areas.
 */
export function topicInTitle(
  titleWords: ReadonlySet<string>,
  tokens: readonly string[],
  softWords: ReadonlySet<string>
): boolean {
  return tokens.some((t) => !softWords.has(t) && titleWords.has(t));
}

/** The words of a query with where each stands in it, split as the index is (see WORD; "V2.27.0" is one word too). */
export function queryWordSpans(query: string): Array<{ word: string; start: number; end: number }> {
  return [...query.matchAll(WORD)].map((m) => ({
    word: m[0],
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/** The words of a query as platformScope reads them: "C++" stays one word. */
function rawQueryWords(query: string): string[] {
  return queryWordSpans(query).map((s) => s.word);
}

/** Query words, capped so one call cannot scale search cost without bound. */
export function tokenizeQuery(query: string): string[] {
  return tokenize(query).slice(0, LIMITS.maxQueryTokens);
}

/** The query words that carry its topic (see searchIndex): all but the action words, when any other is left. */
export function topicTokens(query: string): string[] {
  const tokens = tokenizeQuery(query);
  const topical = tokens.filter((t) => !GENERIC_WORDS.has(t));
  return topical.length > 0 ? topical : tokens;
}

export interface ScoredEntry extends DocEntry {
  score: number;
  /** How many of the query's words matched somewhere. */
  matched: number;
  /**
   * How many matched in the page's own words, its title or description —
   * not only in the section or path it is filed under ("route" for every
   * page under Routing & Navigation).
   */
  matchedOwn: number;
  /** How many words the query had after stopword removal. */
  queryWords: number;
  /** Whether the rarest (most informative) query word matched this entry. */
  coversRarestWord: boolean;
  /**
   * Whether it matched in the title or section — not only in the description
   * or the URL path ("landmark" in /optimization/landmark.md says less than
   * a title does).
   */
  rarestInHeading: boolean;
  /** Whether the rarest query word is a common one (on 40% or more of the pages). */
  rarestIsCommon: boolean;
  /** Share of the query's weight that matched, 0..1 (rare words weigh more). */
  coverage: number;
  /** How many words carry the topic (the query's words less the action words, when any other is left). */
  topicWords: number;
  /** How many of the topic's words matched somewhere. */
  matchedTopic: number;
  /**
   * How many of the topic's words matched in the page's own words — its
   * title, description or file name — not only in the section or directories
   * it is filed under.
   */
  matchedTopicOwn: number;
  /** How many of the query's words matched in the title. */
  matchedTitle: number;
  /**
   * Whether a topic word this page has in no title or section — missing, or
   * only in its description or path — heads some page of the corpus: the
   * documentation has a page about that word, and this is not it.
   */
  headedElsewhere: boolean;
  /**
   * The same, of the pages searched only (one source, as find_across_sdks
   * searches): a word only another source heads ("generate" in C++'s
   * "Generate Territories") is no page this one has on it.
   */
  headedHere: boolean;
  /**
   * Whether a topic word this page has in none of its own words — its title,
   * description or file name; missing, or only in the section or directories
   * it is filed under — heads some page of the corpus: "Social Event Voting",
   * filed under Routing & Navigation, is not the page about routes; the
   * Routing guide is. A common word (on 40% or more of the pages, "map")
   * says too little to count: filed under "Display map items" is enough.
   */
  ownElsewhere: boolean;
  /**
   * Whether the description names the rarest query word as the query writes
   * it — in any of its forms, not as another word the index folds it into
   * ("key" for "token") — in its first sentence and in its first two thirds.
   * A page about a thing names it at once ("A route … between two or more
   * landmarks (waypoints)"); a word in a later sentence or the last third is
   * mentioned in passing ("… its distance from a reference point").
   */
  rarestNamedEarly: boolean;
  /** The query's most specific word (see coversRarestWord), stemmed. */
  rarest: string;
  /**
   * The topic's words (stemmed) the page has nowhere — not in its title,
   * section, description or path — but for those that say what to do rather
   * than what about: action words, and the words of setting up when the
   * query is about something else ("up" in "set up navigation", "install" in
   * "install a voice").
   */
  missingTopic: string[];
}

interface IndexedEntry {
  title: Set<string>;
  /** The page's other names (see ALSO_TITLED), matched as its title is when the query is about them. */
  alsoTitled: Set<string>;
  /** What the page is about in other words (see ALSO_ABOUT), matched as its description is when the query is about them. */
  alsoAbout: Set<string>;
  section: Set<string>;
  description: Set<string>;
  /** Description words found only inside parentheses — an aside ("(safety cameras, …)"), not what the page is about. */
  descriptionAside: Set<string>;
  /** Where each description word first occurs, in words: a page about a thing names it early. */
  descriptionFirst: Map<string, number>;
  /** The sentence (the first is 0) in which each description word first occurs. */
  descriptionSentence: Map<string, number>;
  /** Where each description word, by its own stem (see ownStem), first occurs, in words, and in which sentence. */
  descriptionWritten: Map<string, { at: number; sentence: number }>;
  /**
   * How many words the description has (stopwords left out, repeats
   * counted), not counting what ALSO_SAID appends: those words would put a
   * late word of it in its first two thirds.
   */
  descriptionLength: number;
  path: Set<string>;
  /** The words of the page's own file name, the last part of its path ("create-first-app"): its own, as the title is. */
  slug: Set<string>;
  /**
   * Whether the page introduces its section — an "Overview", "Introduction"
   * or "Get started" by title or file name ("Maps SDK for Android" at
   * guides/introduction.md, "React Native plugin" at introduction.md) — so,
   * on a tie, it comes before the section's other pages.
   */
  entry: boolean;
  titleKey: string;
  /** The title's words as written: "Routing" is not "Routes", though both stem to "rout". */
  titleSurface: string;
  titlePhrase: string;
  descriptionPhrase: string;
  titlePairs: Set<string>;
  descriptionPairs: Set<string>;
}

/**
 * What a description says in other words, added to it for matching: the
 * guides that convert "coordinates to addresses" are about reverse
 * geocoding, though only some of them call it that.
 */
const ALSO_SAID: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bcoordinates?\s+(?:in)?to\s+(?:[\p{L}-]+\s+){0,2}address(?:es)?\b/iu, 'reverse geocoding'],
];

/** The description position of a word it does not have: after any it has. */
const NOT_MENTIONED = Number.MAX_SAFE_INTEGER;

/** A description with what it says in other words (see ALSO_SAID) appended. */
function alsoSaid(description: string): string {
  const extra = ALSO_SAID.filter(([pattern]) => pattern.test(description)).map(([, words]) => words);
  return extra.length === 0 ? description : `${description} ${extra.join(' ')}`;
}

/**
 * Other names of a page, matched as its title is: every SDK's setup page is
 * "Integrate the SDK", and some of their index descriptions are a heading
 * ("Step 1: Add the package"), while people ask how to install or set up
 * the SDK. They count only for a query about that and nothing else ("install
 * the flutter sdk", "sdk setup", "set up"): in "set up voice guidance" or
 * "install offline maps" the words "up" and "install", in no other title,
 * would otherwise be the most specific word and lift the setup page over
 * the topic's guide.
 */
const ALSO_TITLED: ReadonlyArray<readonly [RegExp, string]> = [
  [/^integrate the sdk$/i, 'install installation setup set up'],
];

/**
 * What a page is about in other words than its description's, matched as
 * its description is: the setup pages add the SDK's package to the app
 * project, as a dependency, though some of their descriptions say only "Add
 * the package" or how to install the SDK — so "add the sdk to my project"
 * and "add sdk dependency gradle" find them. Like the other names, these
 * count only for a query about setting up and nothing else; a description
 * word weighs less than a title word, so "create a project" stays with the
 * account's Get Started, which creates one.
 */
const ALSO_ABOUT: ReadonlyArray<readonly [RegExp, string]> = [
  [/^integrate the sdk$/i, 'add the sdk package to your project as a dependency'],
];

/** Every word of the other names and descriptions (see ALSO_TITLED, ALSO_ABOUT), stemmed. */
const ALIAS_WORDS: ReadonlySet<string> = new Set(
  [...ALSO_TITLED, ...ALSO_ABOUT].flatMap(([, words]) => tokenize(words))
);

/** The words of a page's aliases (see ALSO_TITLED, ALSO_ABOUT) whose pattern its title matches; none for most pages. */
function aliasWords(aliases: ReadonlyArray<readonly [RegExp, string]>, title: string): string[] {
  return tokenize(
    aliases
      .filter(([pattern]) => pattern.test(title))
      .map(([, words]) => words)
      .join(' ')
  );
}

/**
 * How the page that introduces a section is titled or named (see
 * IndexedEntry.entry): "Overview", "Introduction", "Get started with
 * positioning", "Getting started with Routing", or a file called
 * introduction.md, overview.md, get-started.md or index.md.
 */
const ENTRY_WORDS: ReadonlySet<string> = new Set(tokenize('overview introduction intro'));
const ENTRY_TITLE = /^get(?:ting)? started\b/i;
const ENTRY_SLUGS: ReadonlySet<string> = new Set([
  'introduction',
  'overview',
  'intro',
  'index',
  'get-started',
  'getting-started',
]);

/** Tokenized fields per entry, computed once per index load. */
const indexed = new WeakMap<DocEntry, IndexedEntry>();

function indexEntry(entry: DocEntry): IndexedEntry {
  let value = indexed.get(entry);
  if (!value) {
    const root = sourceRoot(DOCS.sources.find((s) => s.id === entry.source) as DocSource);
    // Only the part of the path below the source root is scored: the host and
    // the "/docs/flutter/" prefix would otherwise match every page.
    const below = entry.path.startsWith(root) ? entry.path.slice(root.length) : entry.path;
    const slug = below.replace(/\.md$/, '').split('/').pop() as string;
    const titleWords = wordSequence(entry.title);
    const description = alsoSaid(entry.description);
    const described = sequence(description);
    const descriptionWords = described.map((w) => w.word);
    const titleTokens = tokenize(entry.title);
    const outside = new Set(withFamilies(tokenize(description.replace(/\([^()]*\)/g, ' '))));
    const descriptionFirst = new Map<string, number>();
    const descriptionSentence = new Map<string, number>();
    const descriptionWritten = new Map<string, { at: number; sentence: number }>();
    described.forEach(({ word, own, sentence }, i) => {
      for (const w of withFamilies([word])) {
        if (!descriptionFirst.has(w)) {
          descriptionFirst.set(w, i);
          descriptionSentence.set(w, sentence);
        }
      }
      if (!descriptionWritten.has(own)) descriptionWritten.set(own, { at: i, sentence });
    });
    const describedWords = withFamilies(descriptionWords);
    value = {
      title: new Set(withFamilies(titleTokens)),
      alsoTitled: new Set(aliasWords(ALSO_TITLED, entry.title)),
      alsoAbout: new Set(aliasWords(ALSO_ABOUT, entry.title)),
      section: new Set(withFamilies(tokenize(entry.section))),
      description: new Set(describedWords),
      descriptionAside: new Set(describedWords.filter((w) => !outside.has(w))),
      descriptionFirst,
      descriptionSentence,
      descriptionWritten,
      descriptionLength: wordSequence(entry.description).length,
      path: new Set(tokenize(below.replace(/\.md$/, ''))),
      slug: new Set(tokenize(slug)),
      entry: titleTokens.some((t) => ENTRY_WORDS.has(t)) || ENTRY_TITLE.test(entry.title) || ENTRY_SLUGS.has(slug),
      titleKey: titleTokens.join(' '),
      titleSurface: surfaceKey(entry.title),
      titlePhrase: phraseKey(titleWords),
      descriptionPhrase: phraseKey(descriptionWords),
      titlePairs: wordPairs(titleWords),
      descriptionPairs: wordPairs(descriptionWords),
    };
    indexed.set(entry, value);
  }
  return value;
}

export interface SearchOptions {
  /**
   * The entries word rarity is measured on (default: the entries searched).
   * find_across_sdks searches one source at a time but measures rarity over
   * every source, so "the most specific word" means the same in each.
   */
  corpus?: DocEntry[];
  /** A platform the query leans towards (see platformPreference). */
  prefer?: PlatformPreference;
}

/**
 * Rank index entries against a free-text query. Whole words only; rare words
 * weigh more (inverse document frequency); an entry is scaled by how much of
 * the query it covers, so a page matching every word beats one that matches a
 * single common word in its title ("API key" finds the page about API keys,
 * not every "… API"); a title that is exactly the query outranks a title that
 * merely contains it; ties break toward the shorter, more specific title.
 */
export function searchIndex(
  entries: DocEntry[],
  query: string,
  limit: number,
  options: SearchOptions = {}
): ScoredEntry[] {
  const corpus = (options.corpus ?? entries).map(indexEntry);
  // A version no page names stands for its family (see familyOf): "v1.1.x
  // breaking changes" finds the migration guides of 1.1.1, 1.1.2 and 1.1.3.
  const named = (t: string): boolean => corpus.some((f) => f.title.has(t) || f.description.has(t) || f.section.has(t));
  const tokens = tokenizeQuery(query).map((t) => (/^\d+\.\d+$/.test(t) && !named(t) && named(`${t}.*`) ? `${t}.*` : t));
  if (tokens.length === 0) return [];
  // A preference word weighs as little as an action word ("show", "add"):
  // it leans towards its platform, it is not the topic.
  const softWords = new Set(tokenize((options.prefer?.words ?? []).join(' ')));
  const preferred = new Set(options.prefer?.sources ?? []);
  const generic = (t: string): boolean => GENERIC_WORDS.has(t) || softWords.has(t);
  // A platform word left in a query is part of a feature name ("Android
  // Auto", see platformScope): scored like any word, but never the query's
  // "most specific word".
  const topical = tokens.filter((t) => !PLATFORM_WORDS[t]);
  // The query as a phrase, compared word by word on stems: "turn-by-turn
  // navigation" is found in "… turn-by-turn navigation system", and
  // "calculating routes" in "Calculate Route". Only a phrase of two or more
  // words earns the bonus; one word is scored as a word.
  // A preference word is not part of the phrase, nor — on the preferred
  // platform's pages — of the title asked for: "cloud optimization" asks for
  // the Cloud page titled "Optimization" (not for every SDK's).
  const phraseText = (options.prefer?.words ?? []).reduce(
    (text, word) => text.replace(new RegExp(`(?<![\\p{L}\\p{N}+#])${word}(?![\\p{L}\\p{N}+#])`, 'giu'), ' '),
    query
  );
  const queryWords = wordSequence(phraseText);
  const phrase = queryWords.length >= 2 ? phraseKey(queryWords) : undefined;
  const titleTokens = tokens.filter((t) => !softWords.has(t));
  const exact = tokens.join(' ');
  const surface = surfaceKey(query);
  const preferredExact = titleTokens.join(' ');
  const preferredSurface = surfaceKey(phraseText);
  // Pages with pages below them ("Routing" over "Routing › Route Bookmarks"):
  // the overview of a topic, the best answer when the query names just it.
  const parents = new Set(entries.map((e) => e.path.replace(/\/[^/]*$/, '.md')));

  /** Whether some page has the word in its title or section: a topic the documentation has a page on. */
  const heads = (t: string): boolean => corpus.some((f) => f.title.has(t) || f.section.has(t));
  // A page's other names and words (see ALSO_TITLED, ALSO_ABOUT) count as its
  // title and description only when the query is about them and about no
  // topic a page is headed with: "install the sdk", "npm install" and "add
  // the sdk to my project", not "install offline maps".
  const aliased = topical.every((t) => generic(t) || ALIAS_WORDS.has(t) || !heads(t));
  const titled = (f: IndexedEntry, token: string): boolean =>
    f.title.has(token) || (aliased && f.alsoTitled.has(token));
  const described = (f: IndexedEntry, token: string): boolean =>
    f.description.has(token) || (aliased && f.alsoAbout.has(token));
  /** Whether the word is among the page's own: its title, description or file name, not the section it is filed under. */
  const own = (f: IndexedEntry, token: string): boolean => titled(f, token) || described(f, token) || f.slug.has(token);

  const weight = new Map<string, number>();
  for (const token of tokens) {
    let df = 0;
    for (const f of corpus) if (titled(f, token) || described(f, token) || f.path.has(token)) df++;
    const idf = 1 + Math.log((corpus.length + 1) / (df + 1));
    // A preference word only leans towards its platform: it weighs less
    // than an action word, so a title with the topic word beats one with it.
    weight.set(token, softWords.has(token) ? idf / 4 : GENERIC_WORDS.has(token) ? idf / 2 : idf);
  }
  // A word no page has in its title or section ("possible", "recommended")
  // says how the question is put, not what about: it is never the "most
  // specific word" while another word could be.
  const headed = (t: string): boolean => heads(t) || (aliased && corpus.some((f) => f.alsoTitled.has(t)));
  const specific = topical.filter((t) => !generic(t));
  const specificHeaded = specific.filter(headed);
  const candidates =
    specificHeaded.length > 0 ? specificHeaded : specific.length > 0 ? specific : topical.length > 0 ? topical : tokens;
  const rarest = candidates.reduce((best, t) => ((weight.get(t) as number) > (weight.get(best) as number) ? t : best));
  // The rarest word as the query writes it, by its own stem: what a
  // description must say to name it as asked ("token", not "key").
  const rarestWritten = writtenAs(query, rarest);
  // Coverage counts the words that carry the topic: a page about overlays
  // answers "create overlay" even if it never says "create".
  const topicWords = new Set(tokens.filter((t) => !generic(t)).length > 0 ? tokens.filter((t) => !generic(t)) : tokens);
  const totalWeight = [...topicWords].reduce((sum, t) => sum + (weight.get(t) as number), 0);
  /** Whether a word is on 40% or more of the pages ("map"): it says little about which page. */
  const isCommon = (t: string): boolean => (weight.get(t) as number) <= 1 + Math.log(2.5);
  const rarestIsCommon = isCommon(rarest);
  const pairs = titleTokens.slice(1).map((t, i) => `${titleTokens[i]} ${t}`);
  // The topic words some page is headed with: the documentation has a page about them.
  const headedWords = new Set([...topicWords].filter(headed));
  // Of those, the ones a page searched is headed with (see ScoredEntry.headedHere).
  const searched = entries.map(indexEntry);
  const headedHere = new Set(
    [...headedWords].filter((t) =>
      searched.some((f) => f.title.has(t) || f.section.has(t) || (aliased && f.alsoTitled.has(t)))
    )
  );
  /** Whether a word says what to do rather than what about (see ScoredEntry.missingTopic). */
  const phrasing = (t: string): boolean => generic(t) || (!aliased && ALIAS_WORDS.has(t));
  /** Whether the page is one of the examples, not a guide. */
  const isExample = (e: DocEntry): boolean => e.path.includes('/examples/');
  // Whether a guide among the pages searched covers every query word. Then
  // an example whose description says the words in a row ("as the map
  // rotates", for "map rotation") mentions them, it is not the page about
  // them, and the phrase and pair bonuses below are not its to take over
  // the guide; with no such guide, the examples rank by their phrases as
  // ever. Looked up once, when an example's description first calls for it.
  let guideCovers: boolean | undefined;
  const coveredByGuide = (): boolean =>
    (guideCovers ??= entries.some((e) => {
      if (isExample(e)) return false;
      const g = indexEntry(e);
      return tokens.every((t) => titled(g, t) || g.section.has(t) || described(g, t) || g.path.has(t));
    }));

  const scored: ScoredEntry[] = [];
  /**
   * Per scored record: its entry's tokenized fields, and where its description
   * first names a query word (the sentence, and the word). The record is a
   * copy of the entry, so the tie-break reads the fields from here: looking
   * the copy up in the memo would miss and tokenize the page again on every
   * search.
   */
  const about = new Map<ScoredEntry, { fields: IndexedEntry; namedIn: number; namedAt: number }>();
  for (const entry of entries) {
    const f = indexEntry(entry);
    let score = 0;
    let matched = 0;
    let matchedOwn = 0;
    let matchedTitle = 0;
    let matchedWeight = 0;
    let matchedTopic = 0;
    let matchedTopicOwn = 0;
    let coversRarestWord = false;
    let rarestInHeading = false;
    const missingTopic: string[] = [];
    for (const token of tokens) {
      const w = weight.get(token) as number;
      const inTitle = titled(f, token);
      const inSection = f.section.has(token);
      const inDescription = described(f, token);
      const inPath = f.path.has(token);
      if (inTitle) {
        score += 5 * w;
        matchedTitle++;
      }
      if (inSection) score += 2 * w;
      // An aside in parentheses says less about the page than its sentence does.
      if (inDescription) score += f.descriptionAside.has(token) ? w : 2 * w;
      if (inPath) score += w;
      if (inTitle || inSection || inDescription || inPath) {
        matched++;
        if (inTitle || inDescription) matchedOwn++;
        if (topicWords.has(token)) {
          matchedWeight += w;
          matchedTopic++;
          if (own(f, token)) matchedTopicOwn++;
        }
        if (token === rarest) {
          coversRarestWord = true;
          rarestInHeading = inTitle || inSection;
        }
      } else if (topicWords.has(token) && !phrasing(token)) missingTopic.push(token);
    }
    if (matched === 0) continue;
    // A title that is the query: in its exact words ("Routing" for
    // "routing"), more than in its stems only ("Routes"); an overview more
    // than an example with the same title — the topic's page with pages
    // below it, or a cross-SDK developer guide ("Get Started").
    const isPreferred = preferred.has(entry.source);
    // Same stems in other forms count only as a plural ("Routes" for "route"):
    // "Positions" is not the page for "positioning".
    const asked = isPreferred ? preferredSurface : surface;
    if (f.titleKey === (isPreferred ? preferredExact : exact) && sameWords(f.titleSurface, asked)) {
      score += f.titleSurface === asked ? 20 : 10;
      if (parents.has(entry.path) || entry.source === DOCS.sources[0]?.id) score += 6;
    }
    // A description's phrase or pair counts for a guide, and for an example
    // only when no guide searched covers the whole query (see coveredByGuide).
    const descriptionCounts = (): boolean => !isExample(entry) || !coveredByGuide();
    if (phrase) {
      if (f.titlePhrase.includes(phrase)) score += 8;
      if (f.descriptionPhrase.includes(phrase) && descriptionCounts()) score += 4;
    }
    // Adjacent query words that stay adjacent ("live traffic", "api key"),
    // compared as stems on both sides ("calculating routes" ~ "Calculate Route").
    for (const pair of pairs) {
      if (f.titlePairs.has(pair)) score += 4;
      if (f.descriptionPairs.has(pair) && descriptionCounts()) score += 2;
    }
    // Coverage of the query, weighted by rarity: 1 when every word matched.
    const coverage = matchedWeight / totalWeight;
    score *= coverage ** 2;
    // Only action or platform-leaning words matched ("compose" in "compose
    // a message"): nothing of the topic, so no match at all.
    if (score <= 0) continue;
    // Only on the platform's pages about the topic: a title naming one of its words.
    if (isPreferred && topicInTitle(f.title, tokens, softWords)) score *= PREFERRED_SOURCE_BOOST;
    // Where the description first names a word; what the page is about in
    // other words (see ALSO_ABOUT) it names first of all.
    const namedAt = (t: string): number | undefined => (aliased && f.alsoAbout.has(t) ? 0 : f.descriptionFirst.get(t));
    // Where the description first names the rarest word as the query writes it.
    const rarestAt =
      aliased && f.alsoAbout.has(rarest)
        ? { at: 0, sentence: 0 }
        : rarestWritten
            .map((w) => f.descriptionWritten.get(w))
            .reduce<{ at: number; sentence: number } | undefined>(
              (a, b) => (b && (!a || b.at < a.at) ? b : a),
              undefined
            );
    const hit: ScoredEntry = {
      ...entry,
      score,
      matched,
      matchedOwn,
      queryWords: tokens.length,
      coversRarestWord,
      rarestInHeading,
      rarestIsCommon,
      coverage,
      topicWords: topicWords.size,
      matchedTopic,
      matchedTopicOwn,
      matchedTitle,
      headedElsewhere: [...headedWords].some((t) => !titled(f, t) && !f.section.has(t)),
      headedHere: [...headedHere].some((t) => !titled(f, t) && !f.section.has(t)),
      ownElsewhere: [...headedWords].some((t) => !isCommon(t) && !own(f, t)),
      rarestNamedEarly: rarestAt !== undefined && rarestAt.sentence === 0 && 3 * rarestAt.at < 2 * f.descriptionLength,
      rarest,
      missingTopic,
    };
    // How early the description names a query word: on a tie, the page
    // whose description opens with it is about it ("The Magic Lane SDKs …"),
    // more than one that mentions it in passing.
    // The sentence in which the description first names a query word (what
    // the page is about in other words, see ALSO_ABOUT, counts as its first).
    const sentenceOf = (t: string): number | undefined =>
      aliased && f.alsoAbout.has(t) ? 0 : f.descriptionSentence.get(t);
    about.set(hit, {
      fields: f,
      namedIn: Math.min(...tokens.map((t) => sentenceOf(t) ?? NOT_MENTIONED)),
      namedAt: Math.min(...tokens.map((t) => namedAt(t) ?? NOT_MENTIONED)),
    });
    scored.push(hit);
  }

  // Ties go to the cross-SDK developer guides (the account, API key and product
  // pages every SDK refers to), then to guides over examples; then to the
  // page that introduces the topic's section ("Get started with positioning"
  // over "Custom positioning", the React Native plugin's introduction over
  // its examples, the fleet-management Overview over Customers) or opens with
  // the query (each SDK's "Get started" for "Magic Lane", which 55 pages'
  // descriptions name alike); then, among
  // titles naming the topic, to the shorter one ("Traffic Events" over the
  // Compose package "Traffic & roadblocks"; a common word alone, "map" in
  // "tilt the map", names none), and among pages whose titles do not, to the
  // one whose description names it in an earlier sentence, then
  // earlier in it — except within one family of titles, one's words all in
  // the other's ("Calculate Route", "Calculate Bike Route"), where the
  // shorter, plainer title comes first whatever the descriptions say (see
  // familyFirst).
  const rank = (e: DocEntry): number => (e.source === DOCS.sources[0]?.id ? 0 : 2) + (isExample(e) ? 1 : 0);
  const of = (e: ScoredEntry): { fields: IndexedEntry; namedIn: number; namedAt: number } =>
    about.get(e) as { fields: IndexedEntry; namedIn: number; namedAt: number };
  // The entry page of the topic's own section: its title or section names a
  // query word ("Get started with positioning" for "positioning"; not "Get
  // started with Compose" for "add project"), or its description opens with
  // a word of the topic ("The Magic Lane SDKs enable …" for "Magic Lane";
  // not "Add the Compose artifacts …", an action word, for "add project").
  const entry = (e: ScoredEntry): number => {
    const f = of(e).fields;
    const opensWithTopic = [...topicWords].some((t) => f.descriptionFirst.get(t) === 0);
    return f.entry && (tokens.some((t) => f.title.has(t) || f.section.has(t)) || opensWithTopic) ? 0 : 1;
  };
  // The words that tell what the query is about: a common one ("map") says
  // little, so a title with it alone ("Hello Map" for "tilt the map") does
  // not name the topic — unless the query has no other word.
  const telling = tokens.filter((t) => !isCommon(t));
  const naming = telling.length > 0 ? telling : tokens;
  /** 0 when the title names a telling query word, 1 when only the description, section or path does. */
  const inTitle = (e: ScoredEntry): number => (naming.some((t) => titled(of(e).fields, t)) ? 0 : 1);
  const sentence = (e: ScoredEntry): number => of(e).namedIn;
  const position = (e: ScoredEntry): number => of(e).namedAt;
  const family = (a: ScoredEntry, b: ScoredEntry): boolean => {
    const x = of(a).fields.title;
    const y = of(b).fields.title;
    const [small, large] = x.size <= y.size ? [x, y] : [y, x];
    for (const w of small) if (!large.has(w)) return false;
    return true;
  };
  const tie = (a: ScoredEntry, b: ScoredEntry): number =>
    b.score - a.score || b.matched - a.matched || rank(a) - rank(b);
  // Within one class of inTitle, both orders below are the same for every
  // pair, so the comparator stays a lexicographic one.
  scored.sort(
    (a, b) =>
      tie(a, b) ||
      entry(a) - entry(b) ||
      inTitle(a) - inTitle(b) ||
      (inTitle(a) === 0
        ? a.title.length - b.title.length || position(a) - position(b)
        : sentence(a) - sentence(b) || position(a) - position(b) || a.title.length - b.title.length) ||
      a.description.length - b.description.length ||
      a.title.localeCompare(b.title) ||
      a.path.localeCompare(b.path)
  );
  // The family preference goes over each run of tied entries in a pass of
  // its own: as a comparator it is not transitive — two titles can each be
  // of one family with a third and not with each other — so compared
  // pairwise it can form cycles, and the order would depend on the input.
  for (let start = 0; start < scored.length;) {
    let end = start + 1;
    while (end < scored.length && tie(scored[start] as ScoredEntry, scored[end] as ScoredEntry) === 0) end++;
    if (end - start > 1) scored.splice(start, end - start, ...familyFirst(scored.slice(start, end), family));
    start = end;
  }
  return scored.slice(0, limit);
}

/**
 * A run of tied entries in their order, but for one rule: within a family of
 * titles (see searchIndex), the shorter title comes first. Each entry, in
 * turn, moves up to just before the first longer title of its family, and
 * stays where it is otherwise. One pass leaves every such pair right: a
 * family's shorter title has fewer words, so it is of one family with every
 * longer title the other is, and moved before them first.
 */
function familyFirst(run: ScoredEntry[], family: (a: ScoredEntry, b: ScoredEntry) => boolean): ScoredEntry[] {
  const out = [...run];
  for (let i = 1; i < out.length; i++) {
    const e = out[i] as ScoredEntry;
    const j = out.findIndex((o, k) => k < i && o.title.length > e.title.length && family(o, e));
    if (j >= 0) {
      out.splice(i, 1);
      out.splice(j, 0, e);
    }
  }
  return out;
}
