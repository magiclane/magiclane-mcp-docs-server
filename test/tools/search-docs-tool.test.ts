/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedIndex } from '../../src/docs/docs-index.js';
import { seedFullTextSections } from '../../src/docs/full-text.js';
import { DOCS, LIMITS } from '../../src/config/constants.js';
import {
  FLUTTER_FULL,
  FLUTTER_LLMS,
  connectClient,
  isError,
  resetCaches,
  sdkFullTextFixture,
  sdkIndexFixture,
  seedFixtures,
  stubFetch,
  textOf,
} from '../helpers.js';
import type { TestClient } from '../helpers.js';

const CALC = 'https://developer.magiclane.com/docs/flutter/examples/routing-navigation/calculate-route'; // as linked: the web page

interface Structured {
  results: Array<{ title: string; url: string; path: string; source: string; section: string }>;
  excerpts: Array<{ title: string; url?: string; path?: string; source: string; excerpt: string }>;
  failedSources: Array<{ source: string; part: 'index' | 'full-text'; reason: string }>;
  searched?: { query: string; sources: string[] };
}

const structuredOf = (result: unknown): Structured => (result as { structuredContent: Structured }).structuredContent;

describe('search_docs', () => {
  let t: TestClient;
  let restore = (): void => {};

  beforeEach(async () => {
    seedFixtures();
    t = await connectClient();
  });

  afterEach(async () => {
    restore();
    restore = () => {};
    await t.close();
  });

  it('returns matching pages with title, URL, source, and URL-derived section', async () => {
    const result = await t.client.callTool({ name: 'search_docs', arguments: { query: 'calculate route' } });
    const text = textOf(result);
    expect(text).toContain('## Matching pages');
    expect(text).toContain(`1. **Calculate Route** — ${CALC}`);
    expect(text).toContain('Source: flutter · Section: Examples › Routing & Navigation');
    expect(text).not.toContain('Sources not loaded');
  });

  it('appends full-text excerpts, each with its page URL, and lists them in structured output', async () => {
    const result = await t.client.callTool({ name: 'search_docs', arguments: { query: 'MarkerCollection' } });
    const text = textOf(result);
    expect(text).toContain('## Full-text excerpts');
    expect(text).toContain(
      '### Add Markers — https://developer.magiclane.com/docs/flutter/examples/maps-3dscene/add-markers (source: flutter)'
    );
    const structured = structuredOf(result);
    expect(structured.excerpts[0]).toMatchObject({
      title: 'Add Markers',
      path: '/docs/flutter/examples/maps-3dscene/add-markers.md',
      source: 'flutter',
    });
    expect(structured.excerpts[0]!.excerpt).toContain('MarkerCollection');
  });

  it('links pages as web pages inside the structured excerpts too, keeping the paths', async () => {
    seedFullTextSections(
      'developer',
      '## Docs\n\n### Orphan Page\n\nzebra content, see [Routing](/docs/flutter/guides/routing.md#calc).\n'
    );
    const result = await t.client.callTool({ name: 'search_docs', arguments: { query: 'zebra', source: 'developer' } });
    const excerpt = structuredOf(result).excerpts[0]!;
    expect(excerpt.excerpt).toContain('[Routing](https://developer.magiclane.com/docs/flutter/guides/routing#calc)');
    expect(excerpt.excerpt).not.toContain('.md');
    const indexed = structuredOf(
      await t.client.callTool({ name: 'search_docs', arguments: { query: 'MarkerCollection' } })
    ).excerpts[0]!;
    expect(indexed.path).toBe('/docs/flutter/examples/maps-3dscene/add-markers.md');
  });

  it('renders an excerpt without a URL when the page is not in the index', async () => {
    seedFullTextSections('developer', '## Docs\n\n### Orphan Page\n\nzebra content\n');
    const result = await t.client.callTool({
      name: 'search_docs',
      arguments: { query: 'zebra', source: 'developer' },
    });
    expect(textOf(result)).toContain('### Orphan Page (source: developer)');
  });

  it('omits full-text excerpts when includeFullText is false', async () => {
    const result = await t.client.callTool({
      name: 'search_docs',
      arguments: { query: 'calculate route', includeFullText: false },
    });
    expect(textOf(result)).not.toContain('## Full-text excerpts');
    expect(structuredOf(result).excerpts).toEqual([]);
  });

  it('restricts results to the requested source', async () => {
    const result = await t.client.callTool({
      name: 'search_docs',
      arguments: { query: 'markers', source: 'android', includeFullText: false },
    });
    const text = textOf(result);
    expect(text).toContain('Add Markers (android)');
    expect(text).not.toContain('Source: flutter');
  });

  it('respects the result limit', async () => {
    const result = await t.client.callTool({
      name: 'search_docs',
      arguments: { query: 'route', limit: 1, includeFullText: false },
    });
    const text = textOf(result);
    expect(text).toContain('1. ');
    expect(text).not.toContain('2. ');
  });

  it('renders hits that have no description and no section', async () => {
    seedIndex('developer', '- [Bare Page](/docs/bare.md)\n');
    const result = await t.client.callTool({
      name: 'search_docs',
      arguments: { query: 'bare page', source: 'developer', includeFullText: false },
    });
    const text = textOf(result);
    expect(text).toContain('**Bare Page**');
    expect(text).not.toContain('· Section:');
  });

  it('falls back to full-text excerpts when the index has no matches', async () => {
    const result = await t.client.callTool({ name: 'search_docs', arguments: { query: 'RoutePreferences' } });
    const text = textOf(result);
    expect(text).toContain('(No index matches; see full-text excerpts below.)');
    expect(text).toContain('## Full-text excerpts');
  });

  it('suggests next steps and returns empty structured results when nothing matches', async () => {
    const result = await t.client.callTool({ name: 'search_docs', arguments: { query: 'qqqzzz' } });
    expect(textOf(result)).toContain('No documentation pages matched "qqqzzz". Try broader keywords');
    // A query with line breaks is quoted on one line: it cannot add a heading of its own to the reply.
    const folded = textOf(
      await t.client.callTool({ name: 'search_docs', arguments: { query: 'qqqzzz\n\n# zzzzqqq' } })
    );
    expect(folded).toContain('No documentation pages matched "qqqzzz # zzzzqqq". Try broader keywords');
    expect(folded).not.toContain('\n# zzzzqqq');
    expect(isError(result)).toBe(false);
    expect(structuredOf(result)).toEqual({ results: [], excerpts: [], failedSources: [] });
  });

  it('returns structuredContent matching the text results', async () => {
    const result = await t.client.callTool({
      name: 'search_docs',
      arguments: { query: 'calculate route', includeFullText: false },
    });
    expect(structuredOf(result).results[0]).toEqual({
      title: 'Calculate Route',
      url: CALC,
      path: '/docs/flutter/examples/routing-navigation/calculate-route.md',
      description: 'Calculate a route between two coordinates.',
      source: 'flutter',
      section: 'Examples › Routing & Navigation',
    });
  });

  it('names sources that could not be loaded instead of pretending they are empty', async () => {
    resetCaches();
    seedIndex('flutter', FLUTTER_LLMS);
    seedFullTextSections('flutter', FLUTTER_FULL);
    ({ restore } = stubFetch({})); // every other source: 404
    const result = await t.client.callTool({ name: 'search_docs', arguments: { query: 'calculate route' } });
    const text = textOf(result);
    expect(isError(result)).toBe(false);
    expect(text).toContain('**Calculate Route**');
    expect(text).toContain('## Sources not loaded');
    expect(text).toContain('- android index (llms.txt): HTTP 404');
    expect(text).toContain('a problem with the file(s) published on developer.magiclane.com');
    expect(structuredOf(result).failedSources.map((f) => f.source)).toContain('android');
  });

  it('qualifies an empty answer when some sources failed', async () => {
    resetCaches();
    seedIndex('flutter', FLUTTER_LLMS);
    ({ restore } = stubFetch({}));
    const result = await t.client.callTool({ name: 'search_docs', arguments: { query: 'qqqzzz' } });
    expect(textOf(result)).toContain('No documentation pages matched "qqqzzz" in the sources that could be loaded.');
  });

  it('is an error, not an empty result, when no requested source loads at all', async () => {
    resetCaches();
    ({ restore } = stubFetch({}));
    const result = await t.client.callTool({ name: 'search_docs', arguments: { query: 'calculate route' } });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain(
      'Could not load the documentation index for any of the requested documentation source(s)'
    );
    expect(textOf(result)).toContain('- flutter index (llms.txt): HTTP 404');
    expect(textOf(result)).toContain('- flutter page contents (llms-full.txt): HTTP 404');
  });

  it('is an error when no index loads and full text was not requested', async () => {
    resetCaches();
    ({ restore } = stubFetch({}));
    const result = await t.client.callTool({
      name: 'search_docs',
      arguments: { query: 'route', source: 'flutter', includeFullText: false },
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('- flutter index (llms.txt): HTTP 404');
    expect(textOf(result)).not.toContain('page contents');
  });

  it('tells index failures from page-content failures, and still answers from what loaded', async () => {
    resetCaches();
    for (const s of DOCS.sources) seedIndex(s.id, s.id === 'flutter' ? FLUTTER_LLMS : sdkIndexFixture(s.id));
    ({ restore } = stubFetch({})); // every llms-full.txt: 404
    const result = await t.client.callTool({ name: 'search_docs', arguments: { query: 'calculate route' } });
    expect(isError(result)).toBe(false);
    expect(textOf(result)).toContain('**Calculate Route**');
    const failed = structuredOf(result).failedSources;
    expect(failed).toHaveLength(DOCS.sources.length);
    expect(failed.every((f) => f.part === 'full-text')).toBe(true);
    // Only the page contents loaded: the excerpts are the answer, not an error.
    resetCaches();
    seedFullTextSections('flutter', FLUTTER_FULL);
    const excerptsOnly = await t.client.callTool({
      name: 'search_docs',
      arguments: { query: 'calculate route', source: 'flutter' },
    });
    expect(isError(excerptsOnly)).toBe(false);
    expect(textOf(excerptsOnly)).toContain('## Full-text excerpts');
    expect(textOf(excerptsOnly)).toContain(
      'Excerpts from flutter carry no URL because that index could not be loaded (the published file is not ' +
        'usable), so those pages cannot be opened by URL from here.'
    );
    expect(structuredOf(excerptsOnly).failedSources).toEqual([
      { source: 'flutter', part: 'index', reason: expect.stringContaining('HTTP 404'), kind: 'file' },
    ]);
    // An unreachable index is worth a retry, and the note says so.
    restore();
    resetCaches();
    seedFullTextSections('flutter', FLUTTER_FULL);
    ({ restore } = stubFetch({
      'https://developer.magiclane.com/docs/flutter/llms.txt': () => Promise.reject(new TypeError('fetch failed')),
    }));
    const retry = await t.client.callTool({
      name: 'search_docs',
      arguments: { query: 'calculate route', source: 'flutter' },
    });
    expect(textOf(retry)).toContain('search again shortly to get links for them');
  });

  it('loads each index once per call, even with full text', async () => {
    resetCaches();
    const routes: Record<string, string> = {};
    for (const s of DOCS.sources) {
      routes[s.indexUrl] = s.id === 'flutter' ? FLUTTER_LLMS : sdkIndexFixture(s.id);
      routes[s.fullTextUrl as string] = s.id === 'flutter' ? FLUTTER_FULL : sdkFullTextFixture(s.id);
    }
    const stub = stubFetch(routes);
    restore = stub.restore;
    await t.client.callTool({ name: 'search_docs', arguments: { query: 'route' } });
    expect(stub.calls).toHaveLength(2 * DOCS.sources.length);
    expect(new Set(stub.calls).size).toBe(2 * DOCS.sources.length);
  });

  it("says when a platform word could not be checked against that platform's titles", async () => {
    resetCaches();
    seedFullTextSections('android', '## Docs\n\n### Android Auto Navigation\n\nDrive with Auto.\n');
    ({ restore } = stubFetch({})); // the android index: 404
    const result = await t.client.callTool({
      name: 'search_docs',
      arguments: { query: 'Android Auto', includeFullText: true },
    });
    expect(textOf(result)).toContain(
      '"Android" was read as a platform name and left out of the search words; whether it is part of a feature ' +
        'name instead (such as "Android Auto") could not be checked, because the android index could not be loaded.'
    );
    // The structured content says so too.
    expect(result.structuredContent).toMatchObject({ unverified: [{ word: 'Android', source: 'android' }] });
  });

  it('ranks a platform higher for an everyday platform word, still searching every source, and says so', async () => {
    const result = await t.client.callTool({ name: 'search_docs', arguments: { query: 'web markers', limit: 10 } });
    const structured = structuredOf(result) as ReturnType<typeof structuredOf> & { preferred?: string[] };
    expect(structured.results[0]?.source).toBe('typescript');
    expect(new Set(structured.results.map((r) => r.source)).size).toBeGreaterThan(1);
    expect(structured.preferred).toEqual(['typescript']);
    expect(structured.searched).toBeUndefined();
    expect(textOf(result)).toContain(
      'Ranked typescript pages higher, because the query says "web"; other sources are still searched. Add "SDK" ' +
        '("web SDK") to search only there.'
    );
    // The Cloud REST APIs are narrowed with "API".
    const cloud = await t.client.callTool({ name: 'search_docs', arguments: { query: 'cloud markers' } });
    expect(textOf(cloud)).toContain('Add "API" ("cloud API") to search only there.');
    // No Cloud page is on the topic (no title names it): nothing was ranked higher, so nothing is claimed.
    const offTopic = await t.client.callTool({ name: 'search_docs', arguments: { query: 'cloud zebra crossing' } });
    expect(textOf(offTopic)).not.toContain('Ranked');
    expect(structuredOf(offTopic)).not.toHaveProperty('preferred');
    // With a source given, or qualified, there is no preference.
    const given = await t.client.callTool({ name: 'search_docs', arguments: { query: 'web markers', source: 'ios' } });
    expect(structuredOf(given)).not.toHaveProperty('preferred');
    const qualified = await t.client.callTool({ name: 'search_docs', arguments: { query: 'web sdk markers' } });
    expect(structuredOf(qualified)).not.toHaveProperty('preferred');
    expect(textOf(qualified)).not.toContain('Ranked');
    // With the preferred platform's index down, the note does not claim a ranking it could not make.
    resetCaches();
    seedIndex('android', '- [Markers](/docs/android/markers.md): Markers on Android.\n');
    ({ restore } = stubFetch({}));
    const down = textOf(await t.client.callTool({ name: 'search_docs', arguments: { query: 'web markers' } }));
    expect(down).not.toContain('Ranked typescript');
    expect(down).toContain(
      'The query leans towards typescript, but that index could not be loaded, so its pages could not be ranked higher.'
    );
  });

  it('searches for "constructor" like any word, not as a platform that names no source', async () => {
    for (const query of ['constructor', 'MarkerCollection constructor', 'markers constructor flutter']) {
      const result = await t.client.callTool({ name: 'search_docs', arguments: { query } });
      expect(isError(result), query).toBe(false);
      expect(textOf(result), query).not.toContain('Could not load');
    }
  });

  it('searches only the platform a query names, for the rest of the query', async () => {
    seedIndex(
      'flutter',
      '- [Get started](/docs/flutter/guides/get-started.md): Create your first Flutter app.\n' +
        '- [Get started with Navigation](/docs/flutter/guides/navigation/get-started.md): Turn by turn.\n'
    );
    seedIndex(
      'android',
      '- [Get started](/docs/android/guides/get-started.md): Create your first app.\n' +
        '- [Android Auto Navigation](/docs/android/auto.md): Navigate in the car.\n'
    );
    seedFullTextSections('android', '### Get started\n\nGet started on Android.\n');
    const result = await t.client.callTool({ name: 'search_docs', arguments: { query: 'get started flutter' } });
    const structured = structuredOf(result);
    expect(structured.results.map((r) => r.path)).toEqual([
      '/docs/flutter/guides/get-started.md',
      '/docs/flutter/guides/navigation/get-started.md',
    ]);
    expect(structured.excerpts.every((e) => e.source === 'flutter')).toBe(true);
    expect(structured.searched).toEqual({ query: 'get started', sources: ['flutter'] });
    expect(textOf(result)).toContain('Searched for "get started" in flutter only, because the query names that');

    // Part of a feature name: kept in the query, and still only that platform.
    const auto = structuredOf(
      await t.client.callTool({ name: 'search_docs', arguments: { query: 'Android Auto', includeFullText: false } })
    );
    expect(auto.results.map((r) => r.title)).toEqual(['Android Auto Navigation']);
    expect(auto.searched).toEqual({ query: 'Android Auto', sources: ['android'] });

    // An explicit source wins; the platform name is still not a search word.
    const explicitResult = await t.client.callTool({
      name: 'search_docs',
      arguments: { query: 'get started android', source: 'flutter', includeFullText: false },
    });
    const explicit = structuredOf(explicitResult);
    expect(explicit.results[0]!.path).toBe('/docs/flutter/guides/get-started.md');
    expect(explicit.searched).toEqual({ query: 'get started', sources: ['flutter'] });
    expect(textOf(explicitResult)).toContain(
      'Searched for "get started" in flutter, the source given; the platform name in the query was left out'
    );

    // Nothing but a platform name (and stopwords): the name is the search
    // word, looked up in that platform's own pages.
    for (const query of ['flutter', 'what is flutter']) {
      const only = await t.client.callTool({ name: 'search_docs', arguments: { query, includeFullText: false } });
      const structured = structuredOf(only);
      expect(structured.searched, query).toEqual({ query, sources: ['flutter'] });
      expect(structured.results[0]!.path, query).toBe('/docs/flutter/guides/get-started.md');
      expect(textOf(only)).toContain('Searched in flutter only, because the query names that platform.');
      expect(textOf(only)).not.toContain('Leave the platform name out');
    }
    const both = structuredOf(
      await t.client.callTool({
        name: 'search_docs',
        arguments: { query: 'android vs flutter', includeFullText: false },
      })
    );
    expect(both.searched).toEqual({ query: 'android vs flutter', sources: ['android', 'flutter'] });
    expect(both.results.map((r) => r.path)).toContain('/docs/android/auto.md');
    expect(both.results.map((r) => r.path)).toContain('/docs/flutter/guides/get-started.md');

    // An everyday word on the platform list is a search word unless qualified.
    seedIndex('developer', '- [Map Studio](/docs/guides/map-studio.md): The web editor for map styles.\n');
    const web = structuredOf(
      await t.client.callTool({
        name: 'search_docs',
        arguments: { query: 'studio web editor', includeFullText: false },
      })
    );
    expect(web.searched).toBeUndefined();
    expect(web.results[0]!.path).toBe('/docs/guides/map-studio.md');
  });

  it("lists the named platform's overview alone when its own text names a topic no page there has, and its API key in the developer guides too", async () => {
    seedIndex(
      'cloud-rest-api',
      '- [Cloud REST APIs](/docs/cloud-rest-api/introduction.md): Routing, search and more over HTTP.\n' +
        '- [Configuration Parameters](/docs/cloud-rest-api/parameters.md): The API key and other parameters.\n' +
        '- [Routing API](/docs/cloud-rest-api/routing-api.md): Calculate routes.\n'
    );
    seedFullTextSections(
      'cloud-rest-api',
      '# Cloud\n\n## Docs\n\n### Cloud REST APIs\n\nEvery request needs authentication with your API key.\n\n---\n\n' +
        '### Configuration Parameters\n\nThe API key.\n\n---\n\n### Routing API\n\nCalculate routes.\n'
    );
    seedIndex('developer', '- [Get Started](/docs/guides/get-started.md): Create an account and get your API key.\n');
    const search = async (query: string, includeFullText = false) =>
      await t.client.callTool({ name: 'search_docs', arguments: { query, includeFullText } });
    // No Cloud entry says "authentication", but the overview's own text does: it answers alone (its text is
    // loaded for that even when no excerpts are asked for), and the excerpts search the whole query.
    for (const includeFullText of [false, true]) {
      const auth = await search('rest api authentication', includeFullText);
      expect(structuredOf(auth).results.map((r) => r.title)).toEqual(['Cloud REST APIs']);
      expect(structuredOf(auth).searched).toEqual({ query: 'rest api authentication', sources: ['cloud-rest-api'] });
      expect(textOf(auth)).toContain(
        'No page of cloud-rest-api has "authentication" in its title or description: the overview page listed ' +
          '(Cloud REST APIs) names it in its own text, and the excerpts come from the whole query'
      );
    }
    // With the source given, the same.
    const given = await t.client.callTool({
      name: 'search_docs',
      arguments: { query: 'rest api authentication', source: 'cloud-rest-api', includeFullText: false },
    });
    expect(structuredOf(given).searched).toEqual({ query: 'rest api authentication', sources: ['cloud-rest-api'] });
    expect(textOf(given)).toContain('No page of cloud-rest-api has "authentication"');
    // A topic the overview's text does not name either: no page, rather than one that only names the platform,
    // and the note says which sources have pages on it.
    seedIndex('flutter', '- [Weather](/docs/flutter/guides/weather.md): Current conditions and forecasts.\n');
    const weather = await search('rest api weather');
    expect(structuredOf(weather).results).toEqual([]);
    expect(structuredOf(weather).searched).toEqual({ query: 'weather', sources: ['cloud-rest-api'] });
    expect((weather.structuredContent as { elsewhere?: string[] }).elsewhere).toEqual(['flutter']);
    expect(textOf(weather)).toContain('flutter has pages on "weather".');
    seedIndex('ios', '- [Weather](/docs/ios/guides/weather.md): Current conditions and forecasts.\n');
    expect(textOf(await search('rest api weather'))).toContain('flutter, ios have pages on "weather".');
    const zzqx = await search('rest api zzqx');
    expect(structuredOf(zzqx).results).toEqual([]);
    expect((zzqx.structuredContent as { elsewhere?: string[] }).elsewhere).toBeUndefined();
    // The key is created in the account's Get Started: searched along with the Cloud pages.
    const key = structuredOf(await search('rest api key'));
    expect(key.searched).toEqual({ query: 'api key', sources: ['cloud-rest-api', 'developer'] });
    // The output schema describes both: the whole query when the overview answers, and the developer guides added.
    const { tools } = await t.client.listTools();
    const schema = tools.find((x) => x.name === 'search_docs')!.outputSchema as unknown as {
      properties: { searched: { description: string } };
    };
    expect(schema.properties.searched.description).toContain('or the whole query when nothing else matched there');
    expect(schema.properties.searched.description).toContain('plus the developer guides for an API-key question');
    expect(key.results.slice(0, 2).map((r) => r.title)).toEqual(['Get Started', 'Configuration Parameters']);
    // Any other Cloud topic stays with the Cloud pages.
    const routing = structuredOf(await search('rest api routing'));
    expect(routing.searched).toEqual({ query: 'routing', sources: ['cloud-rest-api'] });
    expect(routing.results[0]!.title).toBe('Routing API');
    // Without the overview's text (its page contents do not load), it is not listed, and the failure is named.
    resetCaches();
    seedIndex('cloud-rest-api', '- [Cloud REST APIs](/docs/cloud-rest-api/introduction.md): Routing over HTTP.\n');
    ({ restore } = stubFetch({}));
    const unchecked = await search('rest api authentication');
    expect(structuredOf(unchecked).results).toEqual([]);
    expect(structuredOf(unchecked).failedSources).toEqual([
      expect.objectContaining({ source: 'cloud-rest-api', part: 'full-text' }),
    ]);
    restore();
    seedFixtures();
  });

  it('finds each SDK\'s "Integrate the SDK" for the ways people ask how to install or add it', async () => {
    // The published setup lines, with each SDK's overview and a page that says "project" or "add" too.
    const setup: Record<string, string> = {
      flutter: 'Step 1: Add the package',
      android:
        'This guide describes the steps to install the most recent version of the Maps SDK for Android and ' +
        'configure your Android app to use the SDK.',
      ios:
        'The Magic Lane Maps SDK for iOS is distributed as a Swift Package hosted on GitHub, making it easy to ' +
        'integrate directly into your Xcode projects using Swift Package Manager (SPM).',
      cpp: 'This guide walks you through downloading and integrating the Magic Lane C++ SDK into your project.',
      typescript: 'Add the package',
    };
    const names: Record<string, string> = {
      flutter: 'Flutter',
      android: 'Android',
      ios: 'iOS',
      cpp: 'C++',
      typescript: 'TypeScript',
    };
    for (const id of Object.keys(setup)) {
      seedIndex(
        id,
        `- [Maps SDK for ${names[id]}](/docs/${id}/guides/introduction.md): The Maps SDK for ${names[id]} offers a ` +
          'comprehensive set of features.\n' +
          `- [Minimum requirements](/docs/${id}/guides/introduction/minimum-requirements.md): Supported versions.\n` +
          `- [Integrate the SDK](/docs/${id}/guides/get-started/integrate-sdk.md): ${setup[id]}\n` +
          `- [Create your first app](/docs/${id}/guides/get-started/create-first-app.md): Create a new ${names[id]} ` +
          'application project that uses the Maps SDK.\n' +
          `- [Add Markers](/docs/${id}/examples/maps-3dscene/add-markers.md): Add markers to the map.\n` +
          `- [Projections](/docs/${id}/guides/positioning/projections.md): Convert coordinates between projections.\n`
      );
    }
    const first = async (query: string): Promise<string> => {
      const result = await t.client.callTool({ name: 'search_docs', arguments: { query, includeFullText: false } });
      return structuredOf(result).results[0]?.path ?? '';
    };
    const phrasings = [
      'install the {P} sdk',
      'how do I install the {P} sdk',
      '{P} sdk installation',
      'install {P} sdk',
      'add the {P} sdk to my project',
    ];
    for (const [word, id] of [
      ['flutter', 'flutter'],
      ['android', 'android'],
      ['ios', 'ios'],
      ['c++', 'cpp'],
      ['typescript', 'typescript'],
    ] as Array<[string, string]>) {
      for (const phrasing of phrasings) {
        const query = phrasing.replace('{P}', word);
        expect(await first(query), query).toBe(`/docs/${id}/guides/get-started/integrate-sdk.md`);
      }
    }
    expect(await first('add the sdk to my android project with gradle')).toBe(
      '/docs/android/guides/get-started/integrate-sdk.md'
    );
    expect(await first('add sdk dependency gradle android')).toBe('/docs/android/guides/get-started/integrate-sdk.md');
    // An SDK question is answered by the page on its topic when the platform has one; otherwise by the SDK's
    // overview alone when its own text names the topic, and by no page when it does not.
    expect(await first('ios sdk requirements')).toBe('/docs/ios/guides/introduction/minimum-requirements.md');
    seedFullTextSections(
      'flutter',
      '# Flutter\n\n## Docs\n\n### Maps SDK for Flutter\n\nUse of the SDK is subject to its license.\n\n---\n\n' +
        '### Minimum requirements\n\nSupported versions.\n'
    );
    expect(await first('sdk license flutter')).toBe('/docs/flutter/guides/introduction.md');
    expect(await first('sdk size ios')).toBe('');
  });

  it('rejects an out-of-range limit and an over-long query with validation errors', async () => {
    const limit = await t.client.callTool({ name: 'search_docs', arguments: { query: 'route', limit: 999 } });
    expect(isError(limit)).toBe(true);
    expect(textOf(limit)).toContain('less than or equal to 25');
    const long = await t.client.callTool({
      name: 'search_docs',
      arguments: { query: 'x'.repeat(LIMITS.maxQueryChars + 1) },
    });
    expect(isError(long)).toBe(true);
    expect(textOf(long)).toContain(`at most ${LIMITS.maxQueryChars} character`);
  });
});
