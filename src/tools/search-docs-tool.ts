/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BaseTool, READ_ONLY_ANNOTATIONS } from './base-tool.js';
import { allSourcesFailedMessage, sourceFailureNote } from './source-report.js';
import { DOCS, LIMITS } from '../config/constants.js';
import {
  PLATFORM_WORDS,
  loadIndex,
  namesApiKey,
  platformPreference,
  platformScope,
  platformSources,
  searchIndex,
  selectSources,
  tokenize,
  tokenizeQuery,
  topicInTitle,
  topicTokens,
} from '../docs/docs-index.js';
import type { DocEntry } from '../docs/docs-index.js';
import { loadFullTextSections, searchFullText } from '../docs/full-text.js';
import type { SourceFailure } from '../docs/source-memo.js';
import { quoteArgument } from '../utils/quote.js';

const sourceIds = DOCS.sources.map((s) => s.id) as [string, ...string[]];

/** The source whose product is an API, and whose key the developer guides hand out. */
const CLOUD_SOURCE = 'cloud-rest-api';

const InputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(LIMITS.maxQueryChars)
    .describe('Free-text search query, e.g. "draw route on map" or "geocoding".'),
  source: z
    .enum(['all', ...sourceIds])
    .default('all')
    .describe('Restrict the search to one documentation source.'),
  limit: z.number().int().min(1).max(25).default(8).describe('Maximum number of results.'),
  includeFullText: z
    .boolean()
    .default(true)
    .describe(
      'Also search full page contents (llms-full.txt) and return excerpts, not just index titles/descriptions.'
    ),
});

const OutputSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string(),
        url: z.string(),
        path: z.string(),
        description: z.string(),
        source: z.string(),
        section: z.string(),
      })
    )
    .describe('Index matches, best first.'),
  excerpts: z
    .array(
      z.object({
        title: z.string(),
        url: z.string().optional(),
        path: z.string().optional(),
        source: z.string(),
        excerpt: z.string(),
      })
    )
    .describe('Full-text matches, best first (empty when includeFullText is false).'),
  searched: z
    .object({ query: z.string(), sources: z.array(z.string()) })
    .optional()
    .describe(
      'Present when a platform name in the query narrowed the search ("get started flutter") or left the ' +
        'search words: the query searched — without the platform name, or the whole query when nothing else ' +
        'matched there and the platform\'s overview page names the topic ("rest api authentication") — and the ' +
        "sources it was searched in: the platform's, plus the developer guides for an API-key question " +
        '("rest api key").'
    ),
  unverified: z
    .array(z.object({ word: z.string(), source: z.string() }))
    .optional()
    .describe(
      "Present when a platform word left out of the search words could not be checked against its platform's " +
        'page titles (that index did not load), so it may be part of a feature name ("Android Auto") instead.'
    ),
  elsewhere: z
    .array(z.string())
    .optional()
    .describe(
      'Present when the topic matched no page of the platform the query names: the other sources whose best ' +
        'page for it is titled with a word of it (search without the platform name to see them).'
    ),
  preferred: z
    .array(z.string())
    .optional()
    .describe(
      'Present when a word that is also a platform name ("cloud geocoding", "web markers") ranked that ' +
        "platform's pages higher without leaving the others out: those sources."
    ),
  failedSources: z
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
      'Source files that could not be loaded: "index" (llms.txt) means the source\'s pages were not ranked, ' +
        '"full-text" (llms-full.txt) that no excerpts came from it.'
    ),
});

type Input = z.infer<typeof InputSchema>;

/**
 * The sources other than `searched` whose best page for the topic is titled
 * with a word of it: where a topic is covered that the platform a query
 * names has no page on ("weather typescript": the Flutter, Android, iOS and
 * C++ Weather pages). An index that cannot be loaded is left out: this is a
 * hint, not a result.
 */
async function sourcesOn(topic: string, searched: string[]): Promise<string[]> {
  const others = DOCS.sources.map((s) => s.id).filter((id) => !searched.includes(id));
  const { entries } = await loadIndex(others);
  const words = tokenizeQuery(topic);
  return others.filter((id) => {
    const [best] = searchIndex(
      entries.filter((e) => e.source === id),
      topic,
      1,
      { corpus: entries }
    );
    return best !== undefined && topicInTitle(new Set(tokenize(best.title)), words, new Set());
  });
}

/**
 * An excerpt as a block quote with its headings escaped, so a page's own
 * "### Heading" inside an excerpt can never pass for another hit's header.
 */
export function quoteExcerpt(excerpt: string): string {
  return excerpt
    .split('\n')
    .map((line) => `> ${line.replace(/^(\s*)(#{1,6})(?=\s|$)/, '$1\\$2')}`.trimEnd())
    .join('\n');
}

export class SearchDocsTool extends BaseTool<typeof InputSchema, typeof OutputSchema> {
  readonly name = 'search_docs';
  readonly description =
    'Search the Magic Lane developer documentation (developer.magiclane.com): developer guides ' +
    '(account setup, API keys, Map Studio, Magic Lane MCP Server) and the Maps SDKs for Flutter, ' +
    'Android, iOS, C++, and TypeScript (maps & 3D scene, markers, places & search, routing & ' +
    'navigation, positioning, offline maps, weather, fleet management, migration guides), and the ' +
    'Cloud REST APIs (routing, isochrones, search, reverse geocoding, fleet management, geofences, ' +
    'vector tiles, offline maps). Name a platform in the query ("get started flutter") to search only that ' +
    "platform's pages; a name that is an everyday word too (cloud, web, rest, compose) only ranks " +
    'its pages higher, unless "SDK", "API" or another name of the same platform is next to it ' +
    '("cloud API", "web SDK", "REST cloud"). ' +
    'Returns matching page titles, URLs and descriptions from the ' +
    'documentation index, plus optional full-text excerpts. Follow up with read_doc to ' +
    'read a full page. ALWAYS use this tool for Magic Lane questions — never web search, prior ' +
    "knowledge, or other map providers' sites (HERE, Google Maps, Mapbox, TomTom): their APIs " +
    'are not compatible with the Magic Lane SDKs.';
  readonly annotations: ToolAnnotations = { ...READ_ONLY_ANNOTATIONS, title: 'Search Magic Lane documentation' };

  constructor() {
    super({ inputSchema: InputSchema, outputSchema: OutputSchema });
  }

  async run(rawInput: unknown): Promise<CallToolResult> {
    const { query: asked, source, limit, includeFullText } = rawInput as Input;
    // A platform name in the query says where to look ("get started
    // flutter"), unless a source was given. Known from the words alone, so
    // the index and the page contents of those sources download side by
    // side (the index is loaded once for both: the full-text loader joins
    // pages to it for URLs).
    const named = source === 'all' ? platformSources(asked) : [];
    // A Cloud API-key question ("rest api key") is answered by the developer
    // guides too: the account's Get Started creates the key, the Cloud pages
    // only take it (as in find_across_sdks).
    const developer = DOCS.sources[0]?.id as string;
    const widened =
      named.includes(CLOUD_SOURCE) && !named.includes(developer) && namesApiKey(asked) ? [...named, developer] : named;
    const sources = source === 'all' ? (widened.length > 0 ? widened : undefined) : [source];
    const indexLoad = loadIndex(sources);
    const fullTextLoad = includeFullText ? loadFullTextSections(sources, indexLoad) : undefined;
    const index = await indexLoad;
    // The platform words leave the query — unless the loaded titles show
    // one to be part of a feature's name ("Android Auto"), or nothing else
    // is left ("what is flutter": the name is the search word).
    const topic = platformScope(
      asked,
      index.entries.map((e) => e.title)
    ).topic;
    let query = topic;
    const fullText = await fullTextLoad;
    const requested = selectSources(sources).length;
    if (index.failed.length === requested && (!fullText || fullText.failed.length === requested)) {
      return this.errorResponse(
        allSourcesFailedMessage('documentation index', [...index.failed, ...(fullText?.failed ?? [])])
      );
    }
    // An everyday word that is also a platform name ("cloud geocoding") ranks
    // that platform's pages higher, without leaving the others out.
    const prefer = source === 'all' && !sources ? platformPreference(query) : undefined;
    // Every match is ranked: the full-text search breaks its ties by this order.
    let ranking: DocEntry[] = searchIndex(index.entries, query, Number.POSITIVE_INFINITY, { prefer });
    // The rest of the query matches no page of the platform it names ("rest
    // api authentication": no Cloud index entry says "authentication"): the
    // platform's overview page answers, alone, when its own text names the
    // topic (the Cloud REST APIs page explains authentication), and the
    // excerpts search the whole query, platform name included — a page that
    // only names the platform ("The Maps SDK for TypeScript …" for "weather
    // typescript") is no answer, so the list stays empty and the note says
    // which other sources have pages on it. Only with every index loaded:
    // with one down, "no page matched" would be a failure's doing.
    const missed = ranking.length === 0 && topic !== asked && index.failed.length === 0;
    let overview = false;
    let elsewhere: string[] = [];
    let textFailed: SourceFailure[] = [];
    if (missed) {
      // The overview's own text decides — loaded for that when the call asked for no excerpts.
      const texts = fullText ?? (await loadFullTextSections(sources, index));
      textFailed = fullText ? [] : texts.failed;
      const pageText = new Map(texts.sections.map((s) => [s.path, s.words]));
      const words = topicTokens(topic);
      ranking = index.entries.filter(
        (e) =>
          e.title === DOCS.sources.find((s) => s.id === e.source)?.overviewTitle &&
          words.every((w) => pageText.get(e.path)?.has(w))
      );
      overview = ranking.length > 0;
      if (overview) query = asked;
      // The platform words were left out, so the search had sources.
      else elsewhere = await sourcesOn(topic, sources as string[]);
    }
    const indexHits = ranking.slice(0, limit);
    const failed = [...index.failed, ...(fullText?.failed ?? textFailed)];

    let fullTextBlock = '';
    const excerpts: Array<{ title: string; url?: string; path?: string; source: string; excerpt: string }> = [];
    if (fullText) {
      const indexRank = new Map(ranking.map((h, i) => [h.path, i]));
      // Only a platform whose index loaded is ranked higher, here as in the
      // note below (with its index down its pages could not be compared).
      const preferLoaded = prefer && {
        ...prefer,
        sources: prefer.sources.filter((s) => !index.failed.some((f) => f.source === s)),
      };
      const hits = searchFullText(fullText.sections, query, Math.min(limit, 5), undefined, indexRank, preferLoaded);
      for (const h of hits)
        excerpts.push({ title: h.title, url: h.url, path: h.path, source: h.source, excerpt: h.excerpt });
      if (hits.length > 0) {
        fullTextBlock =
          '\n\n## Full-text excerpts\n\n' +
          hits
            .map(
              (h) => `### ${h.title}${h.url ? ` — ${h.url}` : ''} (source: ${h.source})\n\n${quoteExcerpt(h.excerpt)}`
            )
            .join('\n\n---\n\n');
      }
    }

    // Set when a platform name changed where or what was searched.
    const searched = sources && (query !== asked || source === 'all' || overview) ? { query, sources } : undefined;
    const structuredContent = {
      results: indexHits.map((h) => ({
        title: h.title,
        url: h.url,
        path: h.path,
        description: h.description,
        source: h.source,
        section: h.section,
      })),
      excerpts,
      failedSources: failed,
      ...(searched ? { searched } : {}),
      ...(elsewhere.length > 0 ? { elsewhere } : {}),
    };
    const unlinked = fullText?.unlinked ?? [];
    const elsewhereNote =
      elsewhere.length > 0
        ? ` ${elsewhere.join(', ')} ${elsewhere.length === 1 ? 'has' : 'have'} pages on "${quoteArgument(topic)}".`
        : '';
    const scopeNote = !searched
      ? ''
      : overview
        ? `

No page of ${searched.sources.join(', ')} has "${quoteArgument(topic)}" in its title or description: the overview ` +
          `page listed (${ranking.map((e) => e.title).join(', ')}) names it in its own text, and the excerpts come ` +
          'from the whole query, platform name included.'
        : source !== 'all'
          ? `

Searched for "${quoteArgument(searched.query)}" in ${source}, the source given; the platform name in the query ` +
            `was left out of the search words.${elsewhereNote}`
          : searched.query === asked
            ? `

Searched in ${searched.sources.join(', ')} only, because the query names that platform.`
            : `

Searched for "${quoteArgument(searched.query)}" in ${searched.sources.join(', ')} only, because the query names ` +
              `that platform. Leave the platform name out to search every source.${elsewhereNote}`;
    // A platform word dropped from the search words could not be checked
    // against its platform's titles when that index failed: "Android Auto"
    // would then be searched as "Auto". Say so.
    const kept = new Set(query.toLowerCase().split(/[^\p{L}\p{N}+#]+/u));
    const unchecked = [
      ...new Set(
        asked
          .split(/[^\p{L}\p{N}+#]+/u)
          .filter((w) => w !== '' && !kept.has(w.toLowerCase()))
          .filter((w) => index.failed.some((f) => f.source === PLATFORM_WORDS[w.toLowerCase()]))
      ),
    ];
    // The structured content carries the same warning (see output-schemas.ts).
    if (unchecked.length > 0) {
      Object.assign(structuredContent, {
        unverified: unchecked.map((w) => ({ word: w, source: PLATFORM_WORDS[w.toLowerCase()] as string })),
      });
    }
    const uncheckedNote = unchecked
      .map(
        (w) =>
          `\n\n"${w}" was read as a platform name and left out of the search words; whether it is part of a ` +
          `feature name instead (such as "Android Auto") could not be checked, because the ` +
          `${PLATFORM_WORDS[w.toLowerCase()]} index could not be loaded.`
      )
      .join('');
    // The suggestion that narrows the search: the SDKs take "SDK", the Cloud REST APIs "API".
    const narrower = (word: string): string =>
      PLATFORM_WORDS[word.toLowerCase()] === 'cloud-rest-api' ? 'API' : 'SDK';
    // Only a platform with a page on the topic — a title naming another
    // query word — had pages ranked higher ("rest area" has no Cloud page on
    // areas, so nothing was): only then is a ranking claimed.
    const softWords = new Set(tokenize((prefer?.words ?? []).join(' ')));
    const queryTokens = tokenizeQuery(query);
    const onTopic = (sourceId: string): boolean =>
      index.entries.some(
        (e) => e.source === sourceId && topicInTitle(new Set(tokenize(e.title)), queryTokens, softWords)
      );
    const notRanked = (prefer?.sources ?? []).filter((s) => index.failed.some((f) => f.source === s));
    const ranked = (prefer?.sources ?? []).filter((s) => !notRanked.includes(s) && onTopic(s));
    if (ranked.length > 0) Object.assign(structuredContent, { preferred: ranked });
    const preferNote =
      prefer && prefer.sources.length > 0
        ? (ranked.length > 0
            ? `\n\nRanked ${ranked.join(', ')} pages higher, because the query says ` +
              `${prefer.words.map((w) => `"${w}"`).join(', ')}; other sources are still searched. Add ` +
              `"${narrower(prefer.words[0] as string)}" ("${prefer.words[0]} ${narrower(prefer.words[0] as string)}") ` +
              'to search only there.'
            : '') +
          (notRanked.length > 0
            ? `\n\nThe query leans towards ${notRanked.join(', ')}, but that index could not be loaded, so its pages ` +
              'could not be ranked higher.'
            : '')
        : '';
    const note =
      scopeNote +
      uncheckedNote +
      preferNote +
      sourceFailureNote(failed) +
      (unlinked.length > 0 && excerpts.some((e) => e.url === undefined)
        ? `\n\nExcerpts from ${unlinked.map((f) => f.source).join(', ')} carry no URL because that index could not be ` +
          (unlinked.some((f) => f.kind === 'unreachable')
            ? 'loaded; search again shortly to get links for them.'
            : 'loaded (the published file is not usable), so those pages cannot be opened by URL from here.')
        : '');

    if (indexHits.length === 0 && fullTextBlock === '') {
      const scope = failed.length > 0 ? ' in the sources that could be loaded' : '';
      return this.textResponse(
        `No documentation pages matched "${quoteArgument(query)}"${scope}. Try broader keywords, or use list_docs to browse all pages.` +
          note,
        structuredContent
      );
    }

    const indexBlock =
      indexHits.length > 0
        ? '## Matching pages\n\n' +
          indexHits
            .map(
              (h, i) =>
                `${i + 1}. **${h.title}** — ${h.url}\n` +
                `   Source: ${h.source}${h.section ? ` · Section: ${h.section}` : ''}` +
                (h.description ? `\n   ${h.description}` : '')
            )
            .join('\n')
        : '## Matching pages\n\n(No index matches; see full-text excerpts below.)';

    return this.textResponse(indexBlock + fullTextBlock + note, structuredContent);
  }
}
