/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BaseTool, READ_ONLY_ANNOTATIONS } from './base-tool.js';
import { FAILED_SOURCES_SCHEMA, PAGE_SCHEMA, pageOf } from './output-schemas.js';
import { allSourcesFailedMessage, sourceFailureNote } from './source-report.js';
import { DOCS, LIMITS } from '../config/constants.js';
import {
  PLATFORM_WORDS as PLATFORM_SOURCES,
  loadIndex,
  platformSources,
  queryWordSpans,
  searchIndex,
  tokenize,
  wordHit,
} from '../docs/docs-index.js';
import type { ScoredEntry, WordStats } from '../docs/docs-index.js';
import { loadFullTextSections } from '../docs/full-text.js';
import { quoteArgument } from '../utils/quote.js';

const InputSchema = z.object({
  query: z.string().min(1).max(LIMITS.maxQueryChars).describe('The topic to look up in every SDK, e.g. "add markers".'),
  limitPerSource: z.number().int().min(1).max(5).default(1).describe('How many matches to return per source.'),
});

const OutputSchema = z.object({
  query: z.string(),
  topic: z.string().describe('The query without platform and comparison words — what was looked up.'),
  message: z.string().describe('A one-line summary of the result.'),
  sources: z
    .array(
      z.object({
        source: z.string(),
        name: z.string(),
        status: z
          .enum(['matched', 'no match', 'index not loaded'])
          .describe('"no match": this source has no page on the topic; "index not loaded": see reason.'),
        reason: z.string().optional().describe('Why the index could not be loaded.'),
        matches: z
          .array(
            PAGE_SCHEMA.extend({
              onlyInText: z
                .array(z.string())
                .optional()
                .describe(
                  'Present when the page covers part of the topic: the topic words its title, section and ' +
                    'description lack, which its own text (llms-full.txt) names.'
                ),
            })
          )
          .describe('Best matches first.'),
      })
    )
    .describe('Every documentation source, in a fixed order.'),
  unverified: z
    .array(z.object({ word: z.string(), source: z.string() }))
    .describe(
      "Platform words left out of the topic that could not be checked against their platform's page titles " +
        '(the index of `source` did not load), so one may be part of a feature name ("Android Auto") instead.'
    ),
  failedSources: FAILED_SOURCES_SCHEMA,
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/**
 * Words that name a platform or ask for a comparison. The tool already
 * answers per platform, so "calculate route ios vs android" is the topic
 * "calculate route": left in, "ios" would be the rarest word and no other
 * source could match it.
 */
const PLATFORM_WORDS = new Set([
  ...['flutter', 'dart', 'android', 'kotlin', 'java', 'ios', 'swift', 'swiftui', 'uikit', 'objc'],
  ...['cpp', 'c++', 'typescript', 'javascript', 'ts', 'js', 'web', 'sdk', 'sdks', 'platform', 'platforms'],
  // Everyday words that name a platform too ("cloud geocoding", "compose
  // navigation"): every platform is answered anyway, so they say nothing
  // about the topic — unless a title has them next to a query word.
  ...['cloud', 'rest', 'compose'],
  ...['vs', 'versus', 'compare', 'comparison', 'across', 'between', 'each', 'every', 'both', 'all'],
]);

/**
 * The query without platform and comparison words — unless nothing else is
 * left (not counting stopwords and "API"), or the platform word is part of a
 * feature's name: "Android Auto" is a topic of its own (a page title has it),
 * not "Auto" on Android. "API" next to a platform word ("REST API", "cloud
 * API") is a qualifier, not a feature's name: "rest api routing" is "api
 * routing", which finds Routing API; only "rest api" alone is about the APIs
 * themselves. `titles` are the index titles that decide what counts as a
 * feature name; words are compared stemmed. Function words a dropped word
 * leaves at either end go too ("install the sdk" is "install").
 */
export function topicOf(query: string, titles: string[] = []): string {
  // Split as the index is, in any script ("gauss-krüger" is two words, not three).
  const spans = queryWordSpans(query);
  const words = spans.map((s) => s.word);
  // Stemmed, and cut at punctuation: "Get Started (iOS)" does not name a "started iOS".
  const stemmedTitles = titles.flatMap((t) =>
    t.split(/[()[\]{}:;,.|/—–]+/).map((part) => ` ${tokenize(part).join(' ')} `)
  );
  const inTitle = (phrase: string[]): boolean => stemmedTitles.some((t) => t.includes(` ${phrase.join(' ')} `));
  // The query is a page's title ("integrate the sdk", "maps sdk for
  // flutter"): that page is the topic, platform words and all — "integrate"
  // alone would find the TypeScript "Integrations" over its "Integrate the SDK".
  // Shown as written, less the marks around it (`add "markers"` is the topic
  // `add markers`), as a query with no title to match would be.
  const everyWord = words.map((_, i) => i);
  if (stemmedTitles.includes(` ${tokenize(query).join(' ')} `)) return asWritten(query, spans, everyWord);
  const isPlatform = (w: string | undefined): boolean => w !== undefined && PLATFORM_WORDS.has(w.toLowerCase());
  const named = (a: string | undefined, b: string | undefined): boolean => {
    if (a === undefined || b === undefined) return false;
    const phrase = tokenize(`${a} ${b}`);
    return phrase.length === 2 && !phrase.some((t) => PRODUCT_WORDS.has(t)) && inTitle(phrase);
  };
  const keptAt = words
    .map((_, i) => i)
    .filter(
      (i) =>
        !isPlatform(words[i]) ||
        (!isPlatform(words[i - 1]) && named(words[i - 1], words[i])) ||
        (!isPlatform(words[i + 1]) && named(words[i], words[i + 1]))
    );
  // Nothing left, or nothing but stopwords ("what is flutter") or "API"
  // ("cloud api", "rest apis"): the query is about the platforms or their
  // APIs themselves.
  if (!tokenize(keptAt.map((i) => words[i]).join(' ')).some((t) => !PRODUCT_WORDS.has(t))) return query;
  if (keptAt.length < words.length) {
    // A dropped word takes the function words beside it ("integrate the sdk
    // in a flutter app" is "integrate app", not "integrate the in a app"),
    // and none is left dangling at either end ("install the sdk").
    const isFunctionWord = (i: number | undefined): boolean =>
      i !== undefined && tokenize(words[i] as string).length === 0;
    const kept = new Set(keptAt);
    for (let i = 0; i < words.length; i++) {
      if (kept.has(i)) continue;
      for (let j = i - 1; j >= 0 && kept.has(j) && isFunctionWord(j); j--) kept.delete(j);
      for (let j = i + 1; j < words.length && kept.has(j) && isFunctionWord(j); j++) kept.delete(j);
    }
    keptAt.splice(0, keptAt.length, ...[...kept].sort((a, b) => a - b));
    while (isFunctionWord(keptAt[0])) keptAt.shift();
    while (isFunctionWord(keptAt.at(-1))) keptAt.pop();
  }
  return asWritten(query, spans, keptAt);
}

/** Brackets and the quotes that differ by side, each with the mark that closes it. */
const CLOSING: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}', '«': '»', '“': '”', '‘': '’' };
const OPENING: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CLOSING).map(([open, close]) => [close, open])
);
/** Quotes that open and close alike, paired in turn: the first with the second, the third with the fourth. */
const SAME_BOTH_WAYS: ReadonlySet<string> = new Set(['"', '`', "'"]);

/** Whether the character at `i` is a quote or bracket — not the apostrophe of "don't" or "SDK's". */
function isMark(text: string, i: number): boolean {
  const c = text[i] as string;
  if (CLOSING[c] !== undefined || OPENING[c] !== undefined) return true;
  if (!SAME_BOTH_WAYS.has(c)) return false;
  const letter = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
  return c !== "'" || !(letter(text[i - 1]) && letter(text[i + 1]));
}

/** For each paired quote or bracket of `text`, by offset, the offset of its partner; one without a partner is absent. */
function markPartners(text: string): Map<number, number> {
  const partners = new Map<number, number>();
  const open: number[] = [];
  const waiting = new Map<string, number>();
  for (let i = 0; i < text.length; i++) {
    if (!isMark(text, i)) continue;
    const c = text[i] as string;
    if (CLOSING[c] !== undefined) {
      open.push(i);
    } else if (OPENING[c] !== undefined) {
      const j = open.at(-1);
      if (j !== undefined && text[j] === OPENING[c]) {
        open.pop();
        partners.set(i, j).set(j, i);
      }
    } else {
      const j = waiting.get(c);
      if (j === undefined) waiting.set(c, i);
      else {
        waiting.delete(c);
        partners.set(i, j).set(j, i);
      }
    }
  }
  return partners;
}

/**
 * The kept words of a query as one topic, written as they were: runs of
 * adjacent words keep the text between them ("llms.txt", "3.1.4", "(map)
 * markers"), a dropped word leaves one space — and a quote or bracket whose
 * partner was cut with the dropped words goes too, so `add "markers" on ios`
 * reads `add markers`, not `add "markers`. Partners are told by their place
 * in the query, so `"add" "markers" on "ios"` reads `add markers` though two
 * quotes would have survived into the topic.
 */
function asWritten(query: string, spans: ReadonlyArray<{ start: number; end: number }>, keptAt: number[]): string {
  // Each kept character with its offset in the query; a space standing in for dropped words has none.
  const pieces: Array<{ ch: string; at: number }> = [];
  keptAt.forEach((i, k) => {
    const span = spans[i] as { start: number; end: number };
    const previous = keptAt[k - 1];
    if (previous !== undefined) {
      if (previous === i - 1) {
        for (let at = (spans[previous] as { end: number }).end; at < span.start; at++)
          pieces.push({ ch: query[at] as string, at });
      } else {
        pieces.push({ ch: ' ', at: -1 });
      }
    }
    for (let at = span.start; at < span.end; at++) pieces.push({ ch: query[at] as string, at });
  });
  const kept = new Set(pieces.map((p) => p.at));
  const partners = markPartners(query);
  const stray = (p: { at: number }): boolean => p.at >= 0 && isMark(query, p.at) && !kept.has(partners.get(p.at) ?? -1);
  return pieces
    .filter((p) => !stray(p))
    .map((p) => p.ch)
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * A topic by its words alone, as the index compares them: stemmed, without
 * stopwords or punctuation. Two topics that read `add "markers"` and
 * `add markers` are the same topic.
 */
const stemmed = (topic: string): string => tokenize(topic).join(' ');

/** The source whose product is an API: "API" in a query names it. */
const CLOUD_SOURCE = 'cloud-rest-api';

/** Stemmed words that, next to a platform name, name the product itself rather than a topic. */
const PRODUCT_WORDS = new Set(tokenize('api apis'));

/** "API" phrases that are a topic of the SDK pages too, not a product name: the credential (stems; "API token" folds to it). */
const API_PHRASES: ReadonlySet<string> = new Set(['api key']);

/**
 * The topic without its "API" words, unless one stands in a phrase the SDK
 * pages use too ("api key"): then it is part of the topic, not a product name.
 */
export function withoutLoneApi(topic: string): string {
  const words = queryWordSpans(topic).map((s) => s.word);
  const stems = words.map((w) => tokenize(w)[0]);
  const inPhrase = (i: number): boolean =>
    API_PHRASES.has(`${stems[i - 1]} ${stems[i]}`) || API_PHRASES.has(`${stems[i]} ${stems[i + 1]}`);
  return words.filter((w, i) => !PRODUCT_WORDS.has(stems[i] as string) || inPhrase(i)).join(' ');
}

/** Whether the query is about a platform's API itself ("rest api", "cloud apis"): its only other words are "API". */
function namesPlatformApi(query: string): boolean {
  const words = queryWordSpans(query).map((s) => s.word);
  const rest = tokenize(words.filter((w) => !PLATFORM_WORDS.has(w.toLowerCase())).join(' '));
  return words.some((w) => PLATFORM_WORDS.has(w.toLowerCase())) && rest.some((t) => PRODUCT_WORDS.has(t));
}

/**
 * How many times a page's own text must name a topic word no page is headed
 * with, for the page to answer by it (see answersTopic): once is in passing
 * ("the image UID is cached" is no page on route caching).
 */
const TEXT_MENTIONS = 2;

/**
 * Whether a page is an answer for its source, not a weak partial match
 * ("Optimize" for "display landmarks", "MCP Server" for "configure routing",
 * "Create a Map Style" for "update maps"). It must match at least half of
 * the query's words (all of them for a feature name) — half in its own title
 * or description, not only in its section or path — and:
 * - the most specific word, in its title or section — a description or URL
 *   path that merely mentions it counts only when every other word matched too;
 * - every word, action words included, when even the most specific word is
 *   a common one ("update maps": 40% or more of the pages say "map");
 * - every topic word when the topic has only one or two ("recorder
 *   bookmarks"), and the title or section itself when it has one — as long
 *   as some page is headed with the word the page lacks there: of its own
 *   source for a word its index entry lacks, of any for a single word. Else
 *   the word is matched where the page shows it is about it: a page missing
 *   it in its index entry answers when its own text (`text`, its words in
 *   llms-full.txt) names it at least twice ("landmark store": the Landmarks
 *   guide; "generate territories": the Cloud's Territory, though only C++
 *   heads "generate"; not "route caching": the routing guide never says
 *   "caching"), and a page with a one-word topic in its description only
 *   when that names it, as written, in its first sentence and its first two
 *   thirds, and its text names it again ("waypoints": the Routes guides) —
 *   unless the topic names an API (`withApi`: "api key", "api reference"),
 *   when matching "API" alone, as every Cloud page does, is no answer;
 * - every topic word in its own title, description or file name, not only in
 *   its section, when those hold less than half of all the query's words
 *   ("handle route events": Flutter's "Social Event Voting", under Routing &
 *   Navigation, says only "event" itself) — a common word ("map") in the
 *   section is enough.
 */
export function answersTopic(
  hit: ScoredEntry,
  featureName: boolean,
  aboutPlatforms = false,
  withApi = false,
  text?: WordStats
): boolean {
  /** Whether the page's own text names a word more than once in passing (see TEXT_MENTIONS). */
  const inText = (t: string): boolean => wordHit(text?.get(t) ?? 0).count >= TEXT_MENTIONS;
  // Half of the words that carry the topic: "show me how to add markers" is
  // about markers, so a page on markers answers it whether or not it says
  // "show" or "add".
  if (featureName ? hit.matched < hit.queryWords : hit.matchedTopic * 2 < hit.topicWords) return false;
  // Half of the words in the page's own title or description, not only in
  // the section it is filed under: "Social Event Voting", filed under Routing
  // & Navigation, says nothing of "route events" itself.
  if (!featureName && hit.matchedOwn * 2 < hit.topicWords) return false;
  // A short topic leaves no room for a missing word that some page is headed
  // with: "recorder bookmarks" is not "Route Bookmarks", "camera feed" is not
  // "Feed Sensor Data". A word no page anywhere is titled or filed under
  // ("landmark store", "minimum version") has no page of its own to lose to,
  // so the page about the other word answers when its own text names the
  // missing one — but a topic with "API" in it ("api key", "api reference")
  // is about the other word's API or key: a page matching "API" alone is no
  // answer; and a page whose text names the missing word once at most
  // ("caching" for "route caching") covers only the other word. Nor, when
  // the page's own words (title, description, file name) hold less than half
  // of all the query's words, is there room for a topic word found only in
  // the section the page is filed under: "handle route events" is not
  // Flutter's "Social Event Voting", whose section (Routing & Navigation) is
  // all that says "route", while the Routing guide says all three words. A
  // common word ("map") found in the section is enough ("Traffic Events" for
  // "show traffic on the map"), and so is the section for a query of two
  // words ("record positions": the Recorder, under Positioning & Sensors).
  // A word the description names in passing counts as its own all the same:
  // Android's "Social Event Voting" ("It simulates driving along a route")
  // answers "handle route events", first, as its title holds the rarest
  // word; the Routing guide names "event" in passing too, so the words alone
  // cannot tell which mention is the page's topic.
  // Not when the topic is the platforms themselves ("ios vs android"), each
  // answering for its own name.
  if (!aboutPlatforms && hit.topicWords <= 2) {
    if (hit.matchedTopic < hit.topicWords && (hit.headedHere || withApi || !hit.missingTopic.every(inText))) {
      return false;
    }
    if (hit.matchedOwn * 2 < hit.queryWords && hit.matchedTopicOwn < hit.topicWords && hit.ownElsewhere) return false;
  }
  const allMatched = hit.matched === hit.queryWords;
  if (!hit.coversRarestWord || !(hit.rarestInHeading || allMatched)) return false;
  // One topic word: it must head the page. A description that merely uses
  // it ("order records" for "recorder") is a mention, not the page about it
  // — unless the page's title holds the query's other word ("Update Content"
  // for "update maps"), or no page anywhere is headed with the word, the
  // description names it as asked at once rather than in passing, and the
  // page's text names it again ("waypoints": the Routes guides open with the
  // waypoints a route runs between; "its distance from a reference point" is
  // no page about references, "key concepts" none about the API token, and a
  // category page that names a word once, as "battery-optimized" routing, is
  // none about batteries).
  if (!aboutPlatforms && hit.topicWords === 1 && !hit.rarestInHeading && hit.matchedTitle === 0) {
    if (hit.headedElsewhere || !hit.rarestNamedEarly || !inText(hit.rarest)) return false;
  }
  return !hit.rarestIsCommon || allMatched;
}

export class FindAcrossSdksTool extends BaseTool<typeof InputSchema, typeof OutputSchema> {
  readonly name = 'find_across_sdks';
  readonly description =
    'Given one topic (e.g. "add markers", "calculate route", "offline maps"), return the ' +
    'best-matching documentation page(s) for EVERY source side by side — developer guides, ' +
    'the Maps SDKs for Flutter, Android, iOS, C++, TypeScript, and the Cloud REST APIs. ' +
    'Ideal for cross-platform comparisons ("how do I do X on iOS vs Android"; platform names in the ' +
    'query are ignored unless they are part of a feature name, such as "Android Auto", or of a page\'s title, ' +
    'such as "integrate the sdk", or name the product itself, such as "REST API" — a query that is the title of ' +
    'one of the Cloud REST APIs, such as "geofences api", is answered by that API alone; a query about the ' +
    'platforms themselves, such as "flutter vs android", is answered by each named platform\'s own overview page). ' +
    'A source reports ' +
    '"(no match)" unless a page matches at least half of the topic words (half in its own title or ' +
    'description, not only in its section) and is about the most specific ' +
    "one: it is in the page's title or section, or in its description or path with every other word too " +
    '(every word when even that one is common, such as "map"). A topic of one or two words must match in ' +
    'full, and a single one must head the page — unless the title holds the query\'s other word ("Update ' +
    'Content" for "update maps"), or no page is headed with the word the page lacks there — no page of its ' +
    'source for a word its index entry lacks, no page at all for a single word (never a word next to "API"): ' +
    'then a page whose own text (llms-full.txt) names the missing word at least twice answers, marked as ' +
    'covering part of the topic ("landmark store"; the Cloud\'s Territory for "generate territories"), and a ' +
    'page whose description names the single word as written (not "key" for "token") in its first sentence ' +
    'and its first two thirds answers when its text names it again ("waypoints"); a page may always lack an action ' +
    'word ("upgrade to 3.1.4") or the words of setting up ("set up navigation"). A word the page has only in ' +
    'its section does not count when ' +
    'its own title and description hold less than half of the query\'s words ("handle route events" is not ' +
    '"Social Event Voting", filed under Routing & Navigation). A page that only mentions the topic in passing ' +
    'is not listed; search_docs finds those.';
  readonly annotations: ToolAnnotations = {
    ...READ_ONLY_ANNOTATIONS,
    title: 'Find a topic across all Magic Lane SDKs',
  };

  constructor() {
    super({ inputSchema: InputSchema, outputSchema: OutputSchema });
  }

  async run(rawInput: unknown): Promise<CallToolResult> {
    const { query, limitPerSource } = rawInput as Input;
    // The page contents download beside the indexes: a page whose index entry
    // lacks a word of a short topic answers only when its own text names it.
    const indexLoad = loadIndex();
    const fullTextLoad = loadFullTextSections(undefined, indexLoad);
    const index = await indexLoad;
    const fullText = await fullTextLoad;
    if (index.failed.length === DOCS.sources.length) {
      return this.errorResponse(allSourcesFailedMessage('documentation index', index.failed));
    }
    const textOf = new Map(fullText.sections.map((s) => [s.path, s.words]));
    const topic = topicOf(
      query,
      index.entries.map((e) => e.title)
    );
    // A platform word kept as part of a feature name must match too: a page
    // about "Auto" is no answer to "Android Auto". So must every word of a
    // query about a platform's API ("cloud api", "rest api routing"): an SDK
    // page on routing is no answer to that, the Cloud's Routing API is. The
    // topics are compared by their words: the marks a title match keeps and
    // a plain reading drops (`add "markers"`) name no feature.
    // A query that is the title of one of the Cloud REST APIs ("geofences
    // api": the Geofences API) names that API, as "rest api routing" names
    // the Routing API: the Cloud answers, not an SDK page on geofences.
    const platformApi = namesPlatformApi(query);
    const cloudApi = index.entries.some(
      (e) =>
        e.source === CLOUD_SOURCE &&
        PRODUCT_WORDS.has(tokenize(e.title).at(-1) ?? '') &&
        stemmed(e.title) === stemmed(query)
    );
    const productApi = platformApi || cloudApi;
    const featureName = stemmed(topic) !== stemmed(topicOf(query)) || productApi;
    // Whether a dropped platform word was part of a feature name is decided
    // by that platform's own titles: with its index not loaded, say so
    // instead of passing "Auto" off as the topic of "Android Auto".
    const topicWords = new Set(queryWordSpans(topic).map((s) => s.word));
    const unverified = queryWordSpans(query)
      .map((s) => s.word)
      .filter((w) => !topicWords.has(w))
      .map((w) => ({ word: w, source: PLATFORM_SOURCES[w.toLowerCase()] ?? '' }))
      .filter((p) => p.source !== '' && index.failed.some((f) => f.source === p.source));
    // A query about the platforms themselves ("flutter sdk", "ios vs
    // android", "what is flutter") or about a platform's API ("rest api
    // routing", "geofences api") is answered by the platforms it names only:
    // another SDK's setup page is no answer to "flutter sdk".
    // A platform's API plus a topic ("cloud api key") is answered by that
    // platform and by the cross-SDK developer guides too: the account and
    // API-key pages every SDK refers to are theirs.
    const developer = DOCS.sources[0]?.id as string;
    const apiTopic = platformApi && tokenize(topic).some((t) => !PRODUCT_WORDS.has(t) && !PLATFORM_WORDS.has(t));
    const named = platformApi
      ? [
          ...queryWordSpans(query).flatMap((s) => PLATFORM_SOURCES[s.word.toLowerCase()] ?? []),
          ...(apiTopic ? [developer] : []),
        ]
      : cloudApi
        ? [CLOUD_SOURCE]
        : platformSources(query);
    const onlyNamed = named.length > 0 && (stemmed(topic) === stemmed(query) || productApi);
    // The platforms themselves ("flutter vs android", "what is flutter"): not
    // a topic of theirs, a feature named after one ("Android Auto") or their
    // API ("rest api").
    const aboutPlatforms = onlyNamed && !featureName;
    const blocks: string[] = [];
    const perSource: Output['sources'] = [];
    let total = 0;
    let partly = 0; // sources whose every listed page covers part of the topic

    for (const source of DOCS.sources) {
      const failure = index.failed.find((f) => f.source === source.id);
      if (failure) {
        blocks.push(`## ${source.name} (source: ${source.id})\n\n(index not loaded: ${failure.reason})`);
        perSource.push({
          source: source.id,
          name: source.name,
          status: 'index not loaded',
          reason: failure.reason,
          matches: [],
        });
        continue;
      }
      // A weak partial match ("Address Search" for "add markers", "Create a Map
      // Style" for "offline maps", an "MCP Server" page for "search along
      // route") is worse than an honest "no match": require the most specific
      // topic word and at least half of them. Rarity is judged across ALL
      // sources, so the specific word is the same for every source, and the
      // filter runs before the cut.
      // "API" names the Cloud REST APIs: in an SDK's block it matches nothing
      // ("api" alone would otherwise land on every SDK's "… API" mention) —
      // unless it is part of a phrase the pages use ("API key", "API token").
      // A question about the platforms themselves is answered by each named
      // platform's own page ("Maps SDK for Android"), not by whichever page
      // happens to say the names most ("Android Auto Navigation", or Flutter's
      // "Background Recorder with Foreground Service (Android only)").
      const blockTopic = aboutPlatforms
        ? (source.overviewTitle ?? topic)
        : source.id === CLOUD_SOURCE || source.id === DOCS.sources[0]?.id
          ? topic
          : withoutLoneApi(topic);
      const blockWords = tokenize(blockTopic);
      const answers = !(onlyNamed && !named.includes(source.id)) && blockWords.length > 0;
      const hits = answers
        ? searchIndex(
            index.entries.filter((e) => e.source === source.id),
            blockTopic,
            Number.POSITIVE_INFINITY,
            { corpus: index.entries }
          )
            .filter((h) =>
              answersTopic(
                h,
                featureName,
                aboutPlatforms,
                blockWords.some((t) => PRODUCT_WORDS.has(t)),
                textOf.get(h.path)
              )
            )
            .slice(0, limitPerSource)
        : [];
      if (hits.length === 0) {
        blocks.push(`## ${source.name} (source: ${source.id})\n\n(no match)`);
        perSource.push({ source: source.id, name: source.name, status: 'no match', matches: [] });
        continue;
      }
      total += hits.length;
      // A page that lacks a word of a short topic answered by its text (see
      // answersTopic): its title and description cover part of the topic.
      const onlyInText = (h: ScoredEntry): string[] =>
        aboutPlatforms || h.topicWords > 2
          ? []
          : [
              ...new Set(
                queryWordSpans(blockTopic)
                  .map((w) => w.word)
                  .filter((w) => tokenize(w).some((t) => h.missingTopic.includes(t)))
              ),
            ];
      if (hits.every((h) => onlyInText(h).length > 0)) partly += 1;
      perSource.push({
        source: source.id,
        name: source.name,
        status: 'matched',
        matches: hits.map((h) => {
          const words = onlyInText(h);
          return words.length > 0 ? { ...pageOf(h), onlyInText: words } : pageOf(h);
        }),
      });
      blocks.push(
        `## ${source.name} (source: ${source.id})\n\n` +
          hits
            .map((h) => {
              const words = onlyInText(h);
              const part =
                words.length > 0
                  ? ` (covers part of the topic: ${words.map((w) => `"${w}"`).join(', ')} only in the page's text)`
                  : '';
              return `- [${h.title}](${h.url})${h.description ? ` — ${h.description}` : ''}${part}`;
            })
            .join('\n')
      );
    }

    // With every block shown, a failed index is named in its block; without
    // them (nothing matched), the note names each one itself. Page contents
    // that failed leave the pages that needed them unchecked, and unlisted.
    const failed = [...index.failed, ...fullText.failed];
    const failedNote =
      (total > 0
        ? (index.failed.length > 0
            ? `\n\n${index.failed.length} source(s) could not be loaded (see above) — a problem with the files on ` +
              'developer.magiclane.com or with reaching it, not a documentation gap.'
            : '') +
          (fullText.failed.length > 0
            ? `\n\nThe page contents (llms-full.txt) of ${fullText.failed.map((f) => f.source).join(', ')} could not ` +
              'be loaded, so a page there that lacks a word of the topic in its title and description could not be ' +
              'checked against its text, and is not listed — a problem with the files on developer.magiclane.com ' +
              'or with reaching it, not a documentation gap.'
            : '')
        : sourceFailureNote(failed)) +
      unverified
        .map(
          (p) =>
            `\n\n"${p.word}" was read as a platform name and left out of the topic; whether it is part of a ` +
            `feature name instead (such as "Android Auto") could not be checked, because the ${p.source} index ` +
            'could not be loaded.'
        )
        .join('');
    const structured = (message: string): Output => ({
      query,
      topic,
      message,
      sources: perSource,
      unverified,
      failedSources: failed,
    });

    if (total === 0) {
      const message = `No documentation matched "${quoteArgument(query)}" in any loaded source. Try broader keywords.`;
      return this.textResponse(message + failedNote, structured(message));
    }

    const matched = perSource.filter((s) => s.status === 'matched').length;
    const covered = `${matched} of ${DOCS.sources.length} sources have pages on "${quoteArgument(topic)}"`;
    return this.textResponse(
      `# "${quoteArgument(query)}" across Magic Lane documentation sources\n\n${blocks.join('\n\n')}` + failedNote,
      structured(
        partly > 0 ? `${covered}; in ${partly} of them the pages cover part of it (see onlyInText).` : `${covered}.`
      )
    );
  }
}
