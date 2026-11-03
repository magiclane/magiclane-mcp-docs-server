/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectClient,
  DEVELOPER_LLMS,
  FLUTTER_LLMS,
  isError,
  resetCaches,
  sdkIndexFixture,
  seedFixtures,
  stubFetch,
  textOf,
} from '../helpers.js';
import type { TestClient } from '../helpers.js';

const failedSourcesOf = (result: unknown): unknown[] =>
  (result as { structuredContent: { failedSources: unknown[] } }).structuredContent.failedSources;
import { seedIndex, wordStats } from '../../src/docs/docs-index.js';
import { seedFullTextSections } from '../../src/docs/full-text.js';
import { DOCS, LIMITS } from '../../src/config/constants.js';
import { answersTopic, topicOf } from '../../src/tools/find-across-sdks-tool.js';
import type { ScoredEntry } from '../../src/docs/docs-index.js';

/**
 * Seed one source's index and page contents from the same pages — [title, path below the source root,
 * description, text] — so each page's text (llms-full.txt) is its own.
 */
function seedPages(source: string, pages: Array<[string, string, string, string]>): void {
  seedIndex(
    source,
    pages.map(([title, path, description]) => `- [${title}](/docs/${source}/${path}.md): ${description}\n`).join('')
  );
  seedFullTextSections(
    source,
    `# Docs\n\n## Docs\n\n${pages.map(([title, , , text]) => `### ${title}\n\n${text}`).join('\n\n---\n\n')}\n`
  );
}

describe('find_across_sdks', () => {
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

  it('returns one block per source with the best match', async () => {
    const text = textOf(await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'get started' } }));
    expect(text).toContain('# "get started" across Magic Lane documentation sources');
    expect(text).toContain('[Get Started](https://developer.magiclane.com/docs/guides/get-started)');
    for (const id of ['android', 'ios', 'cpp', 'typescript', 'cloud-rest-api']) {
      expect(text).toContain(`(source: ${id})\n\n- [Get Started (${id})]`);
    }
  });

  it('marks sources without a match, and requires at least half the words to match', async () => {
    const text = textOf(await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'add markers' } }));
    expect(text).toContain('(source: flutter)\n\n- [Add Markers]');
    expect(text).toContain('(source: developer)\n\n(no match)');
    // "Address Search"-style weak matches: one word of three is not enough.
    const weak = textOf(
      await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'markers quaternion gyroscope' } })
    );
    expect(weak).toContain('No documentation matched');
    // Half the words, but not the specific one: "offline maps" must not land on a map-style page.
    const specific = textOf(
      await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'offline maps' } })
    );
    expect(specific).toContain('No documentation matched');
  });

  it('ignores platform and comparison words, which would otherwise match only one source', async () => {
    const text = textOf(
      await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'add markers on iOS vs Android' } })
    );
    for (const id of ['android', 'ios', 'cpp', 'typescript', 'cloud-rest-api']) {
      expect(text).toContain(`(source: ${id})\n\n- [Add Markers (${id})]`);
    }
    expect(topicOf('calculate route ios vs android')).toBe('calculate route');
    expect(topicOf('iOS vs Android')).toBe('iOS vs Android'); // nothing else left: keep it
    // Everyday words that name a platform too say nothing about the topic here.
    expect(topicOf('cloud geocoding')).toBe('geocoding');
    expect(topicOf('compose navigation')).toBe('navigation');
    expect(topicOf('rest routing')).toBe('routing');
  });

  it('does not answer with a page whose own words hold too few of the topic, though its section has more', async () => {
    // The Flutter index: "Social Event Voting" says "route" only through its section.
    seedIndex(
      'flutter',
      '- [Routing & Navigation](/docs/flutter/examples/routing-navigation.md): Examples.\n' +
        '- [Social Event Voting](/docs/flutter/examples/routing-navigation/social-event-voting.md): This guide will ' +
        'teach you how to confirm social reports submitted by other users.\n' +
        '- [Routing](/docs/flutter/guides/routing.md): Routing functionality provides a robust solution for ' +
        'calculating, customizing, and analyzing routes. Retrieve turn-by-turn instructions, traffic event details, ' +
        'and handle public transit routes.\n'
    );
    // The Android index: its "Social Event Voting" names the route in its own description.
    seedIndex(
      'android',
      '- [Social Event Voting](/docs/android/examples/other/social-event-voting.md): This example demonstrates how to ' +
        'let the user vote on social events (community-reported road events) during navigation. It simulates driving ' +
        'along a route and uses an alarm service to detect social reports ahead.\n' +
        '- [Routing](/docs/android/guides/routing.md): Routing functionality provides a robust solution for ' +
        'calculating, customizing, and analyzing routes. Retrieve turn-by-turn instructions, traffic event details, ' +
        'and handle public transit routes.\n'
    );
    const result = await t.client.callTool({
      name: 'find_across_sdks',
      arguments: { query: 'handle route events', limitPerSource: 3 },
    });
    const blocks = (
      result.structuredContent as { sources: Array<{ source: string; matches: Array<{ title: string }> }> }
    ).sources;
    const titles = (source: string): string[] => blocks.find((s) => s.source === source)!.matches.map((m) => m.title);
    // The section is not the page's own words: with three per source asked for, the Flutter block lists Routing alone.
    expect(titles('flutter')).toEqual(['Routing']);
    // A page whose own description names the route is about route events too.
    expect(titles('android')).toContain('Social Event Voting');
    expect(titles('android')).toContain('Routing');
  });

  it("takes a common word from the section, and the file name as the page's own words", async () => {
    // "map" is on most pages: filed under "Display map items" is enough for "display paths on the map".
    seedIndex(
      'flutter',
      '- [Maps](/docs/flutter/guides/maps.md): Display an interactive map.\n' +
        '- [Display map items](/docs/flutter/guides/maps/display-map-items.md): Markers, paths and overlays on the map.\n' +
        '- [Display paths](/docs/flutter/guides/maps/display-map-items/display-paths.md): Paths can be displayed by ' +
        'adding them into MapViewPathCollection.\n' +
        '- [Routing](/docs/flutter/guides/routing.md): Calculate routes.\n'
    );
    // "app" is in the file name, not in the title ("application"): the page's own name.
    seedIndex(
      'typescript',
      '- [Create your first application](/docs/typescript/guides/get-started/create-first-app.md): This guide will ' +
        'walk you through the steps to create a simple web application that displays an interactive map.\n' +
        '- [Get started](/docs/typescript/guides/get-started.md): Create an app and add the SDK.\n'
    );
    const first = async (query: string, source: string): Promise<string | undefined> => {
      const result = await t.client.callTool({ name: 'find_across_sdks', arguments: { query } });
      return (
        result.structuredContent as { sources: Array<{ source: string; matches: Array<{ title: string }> }> }
      ).sources.find((s) => s.source === source)!.matches[0]?.title;
    };
    expect(await first('display paths on the map', 'flutter')).toBe('Display paths');
    expect(await first('create my first app', 'typescript')).toBe('Create your first application');
  });

  it('lists no page that lacks a word of a two-word topic, nor one that only mentions a one-word topic', async () => {
    seedIndex(
      'ios',
      '- [Route Bookmarks](/docs/ios/examples/route-bookmarks.md): Save routes as bookmarks.\n' +
        '- [Order](/docs/ios/guides/order.md): Order records and their history.\n'
    );
    seedIndex(
      'flutter',
      '- [Recorder Bookmarks](/docs/flutter/examples/recorder-bookmarks.md): Bookmark a recording.\n'
    );
    const two = textOf(
      await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'recorder bookmarks' } })
    );
    expect(two).toContain('(source: flutter)\n\n- [Recorder Bookmarks]');
    expect(two).toContain('(source: ios)\n\n(no match)');
    const one = textOf(await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'recorder' } }));
    expect(one).toContain('(source: flutter)\n\n- [Recorder Bookmarks]');
    expect(one).toContain('(source: ios)\n\n(no match)');
  });

  it('matches a short topic where it can when no page anywhere is headed with the word a page lacks', async () => {
    seedPages('flutter', [
      [
        'Landmarks',
        'guides/core/landmarks',
        'A landmark is a permanent location with details.',
        'Landmarks are kept in a landmark store: create a store, then add landmarks to the store.',
      ],
      [
        'Markers',
        'guides/core/markers',
        'A marker is a visual element on the map.',
        'Add markers to a marker collection.',
      ],
      [
        'Migrate to 3.1.4',
        'guides/migration/3-1-4',
        'Breaking changes in SDK version 3.1.4.',
        'Change the calls that 3.1.4 renamed.',
      ],
      [
        'Routing',
        'guides/routing',
        'Compute routes between a list of waypoints and read the summary.',
        'Pass the waypoints in order: the route runs through all the waypoints. Its icon is cached.',
      ],
      [
        'Search',
        'examples/search',
        'Find places and list them with their distance from a reference point.',
        'Sort by the distance from the reference point; the reference is the map center.',
      ],
      [
        'Settings Service',
        'guides/settings-service',
        'The Settings Service stores key-value pairs in permanent storage.',
        'Read a value by its key: each key holds one value.',
      ],
      [
        'Routing & Navigation',
        'examples/routing-navigation',
        'Examples of mode-aware routing, from battery-optimized EV charge paths to bike routes.',
        'Examples of mode-aware routing, from battery-optimized EV charge paths to bike routes.',
      ],
      [
        'Get started with Navigation',
        'guides/navigation/get-started',
        'Start turn-by-turn navigation on a route.',
        'Start navigation and follow the instructions.',
      ],
      ['Get started with maps', 'guides/maps/get-started', 'Display a map.', 'Display a map.'],
      [
        'Update Content',
        'guides/offline/update',
        'Keep downloaded maps and content up to date.',
        'Update the downloaded maps.',
      ],
    ]);
    const blockOf = async (query: string) => {
      const result = await t.client.callTool({ name: 'find_across_sdks', arguments: { query, limitPerSource: 3 } });
      const structured = result.structuredContent as {
        message: string;
        sources: Array<{ source: string; matches: Array<{ title: string; onlyInText?: string[] }> }>;
      };
      return {
        text: textOf(result),
        message: structured.message,
        matches: structured.sources.find((s) => s.source === 'flutter')!.matches,
      };
    };
    const flutter = async (query: string): Promise<string[]> => (await blockOf(query)).matches.map((m) => m.title);
    // "store" heads no page: the page about the other word answers when its own text names the store, and is
    // marked as covering part of the topic.
    const store = await blockOf('landmark store');
    expect(store.matches.map((m) => [m.title, m.onlyInText])).toEqual([['Landmarks', ['store']]]);
    expect(store.text).toContain(`(covers part of the topic: "store" only in the page's text)`);
    expect(store.message).toContain('in 1 of them the pages cover part of it');
    // …and is no answer when its text names the word once in passing ("Its icon is cached"), or not at all.
    expect(await flutter('route caching')).toEqual([]);
    expect(await flutter('marker zzqx')).toEqual([]);
    // "upgrade" is an action word: the migration guide answers.
    expect(await flutter('upgrade to 3.1.4')).toEqual(['Migrate to 3.1.4']);
    // A version with a "v" in either case stays one word, so the block finds its migration page.
    expect(await flutter('migrate to v3.1.4')).toEqual(['Migrate to 3.1.4']);
    expect(await flutter('migrate to V3.1.4')).toEqual(['Migrate to 3.1.4']);
    // A page may lack the words of setting up in a query about something else: they say what to do.
    const setUp = await blockOf('set up navigation');
    expect(setUp.matches.map((m) => m.title)).toEqual(['Get started with Navigation', 'Routing & Navigation']);
    expect(setUp.matches.some((m) => m.onlyInText !== undefined)).toBe(false);
    // "waypoints" heads no page: the guide whose description names it at once, and whose text names it again,
    // answers; a word mentioned in passing, late in a description ("… from a reference point"), is no page about it.
    expect(await flutter('waypoints')).toEqual(['Routing']);
    expect(await flutter('reference')).toEqual([]);
    // A description that names another word the index folds the query's into ("key" for "token") does not name
    // it as asked; nor does a page whose text names the word only once ("battery-optimized" routing examples).
    expect(await flutter('token')).toEqual([]);
    expect(await flutter('battery')).toEqual([]);
    // The title holds the query's action word and the description the topic: about it, though "map" heads other pages.
    expect((await flutter('update maps'))[0]).toBe('Update Content');
    // "API" and a word: a page matching "API" alone is no answer, though "key" heads no page.
    seedIndex(
      'cloud-rest-api',
      '- [Vector Tiles API](/docs/cloud-rest-api/tiles.md): Map tiles over HTTP.\n' +
        '- [Configuration Parameters](/docs/cloud-rest-api/parameters.md): The API key and other parameters.\n'
    );
    const cloud = async (query: string): Promise<string[]> => {
      const result = await t.client.callTool({ name: 'find_across_sdks', arguments: { query, limitPerSource: 3 } });
      return (
        result.structuredContent as { sources: Array<{ source: string; matches: Array<{ title: string }> }> }
      ).sources
        .find((s) => s.source === 'cloud-rest-api')!
        .matches.map((m) => m.title);
    };
    expect(await cloud('api key')).toEqual(['Configuration Parameters']);
    // With "get" unmatched, the page must hold its most specific word in a heading: neither does.
    expect(await cloud('how do I get an api key')).toEqual([]);
  });

  it("lets a page lack a short topic's word that only another source heads, when its own text names it", async () => {
    seedPages('cpp', [
      ['Generate Territories', 'examples/generate-territories', 'Generate territories from points.', 'Generate them.'],
    ]);
    // "generate" is a common word, "territories" the specific one, as in the published indexes.
    seedPages('cloud-rest-api', [
      [
        'Territory',
        'guides/territory',
        'Manage the territories of a fleet.',
        'Generate a territory; generate its shape.',
      ],
      ['Routing API', 'guides/routing-api', 'Generate routes between places.', 'Routes.'],
      ['Isochrones API', 'guides/isochrones-api', 'Generate the areas reachable in a time.', 'Areas.'],
    ]);
    const result = await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'generate territories' } });
    const sources = (
      result.structuredContent as {
        sources: Array<{ source: string; matches: Array<{ title: string; onlyInText?: string[] }> }>;
      }
    ).sources;
    const matches = (source: string) => sources.find((s) => s.source === source)!.matches;
    // "generate" heads a C++ page, but no Cloud page: the Cloud's Territory guide, whose text names it, answers.
    expect(matches('cpp').map((m) => m.title)).toEqual(['Generate Territories']);
    expect(matches('cloud-rest-api').map((m) => [m.title, m.onlyInText])).toEqual([['Territory', ['generate']]]);
  });

  it('applies the match rule before keeping the best page, and judges rarity across all sources', async () => {
    seedIndex(
      'developer',
      '- [Map Map Basics](/docs/guides/map-basics.md): The map, the map.\n' +
        '- [Zebra Crossings](/docs/guides/crossings.md): Crossing rules on the map.\n'
    );
    const text = textOf(await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'map zebra' } }));
    expect(text).toContain('(source: developer)\n\n- [Zebra Crossings]');
  });

  it('requires the most specific topic word: a page sharing only common words is no match', async () => {
    seedIndex(
      'developer',
      '- [MCP Server](/docs/guides/mcp.md): Search places and calculate a route.\n' +
        '- [Get Started](/docs/guides/get-started.md): Create an account.\n'
    );
    seedIndex(
      'flutter',
      '- [Search Along Route](/docs/flutter/along.md): Find places along the route.\n' +
        '- [Search](/docs/flutter/search.md): Search places.\n'
    );
    const result = await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'search along route' } });
    const sources = (result.structuredContent as { sources: Array<{ source: string; status: string }> }).sources;
    expect(sources.find((s) => s.source === 'developer')!.status).toBe('no match');
    expect(textOf(result)).toContain('(source: flutter)\n\n- [Search Along Route]');
  });

  it('keeps a platform word that is part of a feature name, and then requires it', async () => {
    seedIndex('android', '- [Android Auto Navigation](/docs/android/auto.md): Navigate in the car.\n');
    seedIndex('flutter', '- [SDK Automatic Activation](/docs/flutter/sdk-auto-activation.md): Activate the SDK.\n');
    const result = await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'Android Auto' } });
    const structured = result.structuredContent as {
      topic: string;
      sources: Array<{ source: string; status: string }>;
    };
    expect(structured.topic).toBe('Android Auto');
    expect(structured.sources.find((s) => s.source === 'android')!.status).toBe('matched');
    expect(structured.sources.find((s) => s.source === 'flutter')!.status).toBe('no match');
    expect(topicOf('Android Auto', ['Android Auto Navigation'])).toBe('Android Auto');
    expect(topicOf('auto android', ['Android Auto Navigation'])).toBe('auto'); // not the name's word order
    expect(topicOf('markers on Android', ['Android Auto Navigation'])).toBe('markers');
  });

  it('reads "rest api" and "cloud api" as the Cloud REST APIs themselves, not as "api" in every SDK', async () => {
    seedIndex('cloud-rest-api', '- [Cloud REST APIs](/docs/cloud-rest-api/intro.md): Routing, search and more.\n');
    seedIndex('flutter', '- [API Reference](/docs/flutter/api.md): The API of the SDK.\n');
    seedIndex('developer', '- [Get Started](/docs/guides/get-started.md): Your account and the REST API key.\n');
    for (const query of ['rest api', 'cloud api', 'REST APIs']) {
      const result = await t.client.callTool({ name: 'find_across_sdks', arguments: { query } });
      const structured = result.structuredContent as {
        topic: string;
        sources: Array<{ source: string; status: string }>;
      };
      expect(structured.topic, query).toBe(query);
      expect(structured.sources.find((s) => s.source === 'cloud-rest-api')!.status, query).toBe('matched');
      expect(structured.sources.find((s) => s.source === 'flutter')!.status, query).toBe('no match');
      // The APIs themselves, not a topic of theirs: the developer guides stay out too.
      expect(structured.sources.find((s) => s.source === 'developer')!.status, query).toBe('no match');
    }
    // "API" after a platform word is a qualifier, never part of a feature name.
    expect(topicOf('cloud rest api', ['Cloud REST APIs'])).toBe('cloud rest api');
    expect(topicOf('rest api routing', ['Cloud REST APIs'])).toBe('api routing');
    expect(topicOf('rest routing', ['Cloud REST APIs'])).toBe('routing');
    // A stopword is no neighbor ("flutter the" names no title), and one left dangling goes.
    expect(topicOf('markers flutter the', ['Flutter Markers'])).toBe('markers');
    expect(topicOf('install the sdk')).toBe('install');
    expect(topicOf('the sdk markers')).toBe('markers');
    expect(topicOf('fly to')).toBe('fly to'); // nothing dropped: the query as written
  });

  it("answers a query that is a Cloud REST API's title with that API alone", async () => {
    seedIndex(
      'cloud-rest-api',
      '- [Geofences API](/docs/cloud-rest-api/geofences-api.md): Create geofences and monitor assets.\n'
    );
    seedIndex(
      'android',
      '- [Avoid Geofence Area](/docs/android/examples/avoid-geofence-area.md): Route around a geofence area.\n' +
        '- [Weather](/docs/android/guides/weather.md): The WeatherService class gives forecasts.\n'
    );
    const blocks = async (query: string): Promise<Record<string, string[]>> => {
      const result = await t.client.callTool({ name: 'find_across_sdks', arguments: { query } });
      const sources = (
        result.structuredContent as { sources: Array<{ source: string; matches: Array<{ title: string }> }> }
      ).sources;
      return Object.fromEntries(sources.map((b) => [b.source, b.matches.map((m) => m.title)]));
    };
    // "geofences api" names the Geofences API, as "rest api geofences" would: no SDK page on geofences answers it.
    const geofences = await blocks('geofences api');
    expect(geofences['cloud-rest-api']).toEqual(['Geofences API']);
    expect(geofences.android).toEqual([]);
    // No Cloud REST API is titled "Weather API": each SDK's own weather API answers.
    expect((await blocks('weather api')).android).toEqual(['Weather']);
  });

  it("keeps a query that is a page's title whole, platform words and all, and asks for every word", async () => {
    // "integrate" alone would list the TypeScript "Integrations" and "Plugin integration" first.
    seedIndex(
      'typescript',
      '- [Integrations](/docs/typescript/integrations.md): A lightweight variant and framework integrations of the ' +
        'Magic Lane Maps SDK for TypeScript.\n' +
        '- [Plugin integration](/docs/typescript/integrations/react-native/plugin-integration.md): The Magic Lane ' +
        'Maps SDK for React Native is built on top of the TypeScript SDK.\n' +
        '- [Integrate the SDK](/docs/typescript/guides/get-started/integrate-sdk.md): Add the package\n'
    );
    seedIndex(
      'flutter',
      '- [Integrate the SDK](/docs/flutter/guides/get-started/integrate-sdk.md): Step 1: Add the package\n'
    );
    expect(topicOf('integrate the sdk', ['Integrate the SDK'])).toBe('integrate the sdk');
    expect(topicOf('Integrate the SDK', ['Integrate the SDK'])).toBe('Integrate the SDK');
    expect(topicOf('integrate the sdk?', ['Integrate the SDK'])).toBe('integrate the sdk');
    expect(topicOf('integrate the sdk')).toBe('integrate');
    const result = await t.client.callTool({
      name: 'find_across_sdks',
      arguments: { query: 'integrate the sdk', limitPerSource: 3 },
    });
    const structured = result.structuredContent as {
      topic: string;
      sources: Array<{ source: string; status: string; matches: Array<{ title: string }> }>;
    };
    expect(structured.topic).toBe('integrate the sdk');
    expect(structured.sources.find((s) => s.source === 'typescript')!.matches[0]!.title).toBe('Integrate the SDK');
    expect(structured.sources.find((s) => s.source === 'flutter')!.matches.map((m) => m.title)).toEqual([
      'Integrate the SDK',
    ]);
    // A platform's own title names that platform's page, and nothing on the others.
    seedIndex('android', '- [Maps SDK for Android](/docs/android/guides/introduction.md): The Maps SDK for Android.\n');
    seedIndex('ios', '- [Maps SDK for iOS](/docs/ios/guides/introduction.md): The Maps SDK for iOS.\n');
    const named = (
      (await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'maps sdk for ios' } }))
        .structuredContent as typeof structured
    ).sources;
    expect(named.find((s) => s.source === 'ios')!.matches[0]!.title).toBe('Maps SDK for iOS');
    expect(named.filter((s) => s.status === 'matched').map((s) => s.source)).toEqual(['ios']);
  });

  it("reads a page's title with marks around it as that title, not as a feature name", async () => {
    // Android's guide is titled "Markers" and says nothing of adding. With the quotes kept in the topic, the
    // topic differed from its plain reading, so it was taken for a feature name and every word was required:
    // the guide was no match, and the topic shown kept the quotes.
    seedIndex('android', '- [Markers](/docs/android/guides/markers.md): Display markers on the map.\n');
    for (const query of ['add "markers"', 'add markers!', '(add markers)', '`add markers`']) {
      expect(topicOf(query, ['Add Markers'])).toBe('add markers');
      const result = await t.client.callTool({ name: 'find_across_sdks', arguments: { query } });
      const structured = result.structuredContent as {
        topic: string;
        message: string;
        sources: Array<{ source: string; status: string; matches: Array<{ title: string }> }>;
      };
      expect(structured.topic).toBe('add markers');
      expect(structured.message).toBe('6 of 7 sources have pages on "add markers".');
      expect(structured.sources.find((s) => s.source === 'android')!.matches.map((m) => m.title)).toEqual(['Markers']);
      expect(structured.sources.filter((s) => s.status === 'matched').map((s) => s.source)).toEqual([
        'flutter',
        'android',
        'ios',
        'cpp',
        'typescript',
        'cloud-rest-api',
      ]);
    }
    // A platform's own title with a mark after it still names that platform's page alone.
    seedIndex('ios', '- [Maps SDK for iOS](/docs/ios/guides/introduction.md): The Maps SDK for iOS.\n');
    const named = (await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'Maps SDK for iOS.' } }))
      .structuredContent as { topic: string; sources: Array<{ source: string; status: string }> };
    expect(named.topic).toBe('Maps SDK for iOS');
    expect(named.sources.filter((s) => s.status === 'matched').map((s) => s.source)).toEqual(['ios']);
  });

  it('answers "rest api" plus a topic with the Cloud page on that topic, and no SDK page', async () => {
    seedIndex(
      'cloud-rest-api',
      '- [Cloud REST APIs](/docs/cloud-rest-api/intro.md): Routing, search and more.\n' +
        '- [Routing API](/docs/cloud-rest-api/routing-api.md): Calculate routes.\n'
    );
    seedIndex('flutter', '- [Routing](/docs/flutter/routing.md): Calculate routes on the device.\n');
    const result = await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'rest api routing' } });
    const structured = result.structuredContent as {
      topic: string;
      sources: Array<{ source: string; status: string; matches: Array<{ title: string }> }>;
    };
    expect(structured.topic).toBe('api routing');
    expect(structured.sources.find((s) => s.source === 'cloud-rest-api')!.matches[0]!.title).toBe('Routing API');
    expect(structured.sources.find((s) => s.source === 'flutter')!.status).toBe('no match');
    // The cross-SDK developer guides answer a platform-API topic too: "cloud api key" is also the account's
    // Get Started.
    seedIndex('developer', '- [Get Started](/docs/guides/get-started.md): Create an account and get your API key.\n');
    seedIndex(
      'cloud-rest-api',
      '- [Configuration Parameters](/docs/cloud-rest-api/parameters.md): The API key parameter.\n'
    );
    const keyed = (await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'cloud api key' } }))
      .structuredContent as { sources: Array<{ source: string; status: string; matches: Array<{ title: string }> }> };
    expect(keyed.sources.find((s) => s.source === 'developer')!.matches[0]!.title).toBe('Get Started');
    expect(keyed.sources.find((s) => s.source === 'cloud-rest-api')!.matches[0]!.title).toBe(
      'Configuration Parameters'
    );
    expect(keyed.sources.find((s) => s.source === 'flutter')!.status).toBe('no match');
    // A comparison of platforms needs no API: "ios vs android" still finds each SDK's own page.
    seedIndex('ios', '- [Maps SDK for iOS](/docs/ios/intro.md): The iOS SDK.\n');
    const vs = (await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'ios vs android' } }))
      .structuredContent as typeof structured;
    expect(vs.sources.find((s) => s.source === 'ios')!.status).toBe('matched');
  });

  it("answers a query about the platforms themselves, or a platform's API, from the platforms it names only", async () => {
    seedIndex('flutter', '- [Maps SDK for Flutter](/docs/flutter/intro.md): The Flutter SDK.\n');
    seedIndex('android', '- [Integrate the SDK](/docs/android/integrate.md): Add the SDK, for Flutter users too.\n');
    const sources = async (query: string) =>
      (
        (await t.client.callTool({ name: 'find_across_sdks', arguments: { query } })).structuredContent as {
          sources: Array<{ source: string; status: string }>;
        }
      ).sources
        .filter((s) => s.status === 'matched')
        .map((s) => s.source);
    expect(await sources('flutter sdk')).toEqual(['flutter']);
    // "API" names the Cloud REST APIs: it matches nothing in an SDK's block.
    seedIndex('ios', '- [Public Transit Stops](/docs/ios/pt.md): Stops from the public transit API.\n');
    expect(await sources('api')).not.toContain('ios');
  });

  it("answers a query about the platforms themselves with each platform's own overview page", async () => {
    // The pages that say the names most are not the pages about the platforms.
    seedIndex(
      'flutter',
      '- [Background Recorder with Foreground Service (Android only)](/docs/flutter/examples/background-recorder.md): ' +
        'This example demonstrates how to build a Flutter app using the Maps SDK to record positions in the ' +
        'background.\n' +
        '- [Maps SDK for Flutter](/docs/flutter/guides/introduction.md): The Maps SDK for Flutter offers a powerful ' +
        'and comprehensive set of features.\n' +
        '- [Minimum requirements](/docs/flutter/guides/introduction/minimum-requirements.md): The Maps SDK for ' +
        'Flutter enables the development of applications for Android, iOS and more.\n'
    );
    seedIndex(
      'android',
      '- [Android Auto Navigation](/docs/android/examples/routing-navigation/android-auto-navigation.md): This ' +
        'example brings full turn-by-turn navigation to the Android Auto car head unit.\n' +
        '- [Maps SDK for Android](/docs/android/guides/introduction.md): The Maps SDK for Android offers a powerful ' +
        'and comprehensive set of features.\n' +
        '- [Minimum requirements](/docs/android/guides/introduction/minimum-requirements.md): Before developing ' +
        'with the Maps SDK for Android, check the requirements.\n'
    );
    const result = await t.client.callTool({
      name: 'find_across_sdks',
      arguments: { query: 'flutter vs android', limitPerSource: 2 },
    });
    const blocks = (
      result.structuredContent as {
        topic: string;
        sources: Array<{ source: string; status: string; matches: Array<{ title: string }> }>;
      }
    ).sources;
    const titles = (source: string): string[] => blocks.find((s) => s.source === source)!.matches.map((m) => m.title);
    expect(titles('flutter')).toEqual(['Maps SDK for Flutter', 'Minimum requirements']);
    expect(titles('android')).toEqual(['Maps SDK for Android', 'Minimum requirements']);
    // Only the platforms named answer; the topic shown is still the query.
    expect(blocks.filter((s) => s.status === 'matched').map((s) => s.source)).toEqual(['flutter', 'android']);
    expect((result.structuredContent as { topic: string }).topic).toBe('flutter vs android');
  });

  it('splits the query as the index does, and shows the topic as written', async () => {
    expect(topicOf('gauss-krüger projection on android')).toBe('gauss-krüger projection');
    expect(topicOf('read llms.txt in flutter')).toBe('read llms.txt');
    expect(topicOf('flutter migrate to 3.1.4')).toBe('migrate to 3.1.4');
    expect(topicOf('flutter migrate to V2.27.0')).toBe('migrate to V2.27.0');
    expect(topicOf('add ios markers')).toBe('add markers'); // a dropped word leaves one space
    // The function words beside a dropped word go with it: no holes in the topic shown.
    expect(topicOf('integrate the sdk in a flutter app')).toBe('integrate app');
    expect(topicOf('activate the flutter sdk with a license key')).toBe('activate license key');
    expect(topicOf('markers and the android sdk')).toBe('markers');
    // …and none is left dangling at either end.
    expect(topicOf('the markers android')).toBe('markers');
    expect(topicOf('android markers the')).toBe('markers');
    // A quote or bracket whose partner was cut with the dropped words goes too; a pair that survives stays.
    expect(topicOf('add "markers" on ios')).toBe('add markers');
    expect(topicOf("'add markers' on ios")).toBe('add markers');
    expect(topicOf('use `calculateRoute` on ios')).toBe('calculateRoute');
    expect(topicOf('add (markers) on ios')).toBe('add markers');
    expect(topicOf('add (markers] on ios')).toBe('add markers'); // mismatched brackets pair with nothing
    expect(topicOf('add (map) markers on ios')).toBe('add (map) markers');
    expect(topicOf('add «markers» on ios')).toBe('add markers');
    // Partners are told by their place in the query: two quotes left in the topic are both stray here, while
    // the first pair stays when only the second lost its partner.
    expect(topicOf('"add" "markers" on "ios"')).toBe('add markers');
    expect(topicOf('add "markers" and "overlays" on ios')).toBe('add "markers" and overlays');
    // An apostrophe is no quote.
    expect(topicOf("don't drop the sdk's markers on ios")).toBe("don't drop markers");
  });

  it('renders a hit without a description plainly', async () => {
    seedIndex('developer', '- [Bare Zebra](/docs/guides/bare-zebra.md)\n');
    const text = textOf(await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'zebra' } }));
    expect(text).toContain('- [Bare Zebra](https://developer.magiclane.com/docs/guides/bare-zebra)\n');
    expect(text).not.toContain('Bare Zebra](https://developer.magiclane.com/docs/guides/bare-zebra) —');
  });

  it('honours limitPerSource', async () => {
    const one = textOf(await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'route' } }));
    expect(one.match(/\(source: flutter\)\n\n(- .*\n?)+/)?.[0].split('\n- ').length).toBe(2);
    const three = textOf(
      await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'route', limitPerSource: 3 } })
    );
    expect((three.match(/- \[.*Route/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('says so when no source matches at all', async () => {
    const result = await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'qqqzzz' } });
    expect(isError(result)).toBe(false);
    expect(textOf(result)).toContain('No documentation matched "qqqzzz" in any loaded source');
    // A query with line breaks is quoted on one line: it cannot add a heading or a source block of its own.
    const folded = textOf(
      await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'qqqzzz\n\n## zzzzqqq' } })
    );
    expect(folded).toContain('No documentation matched "qqqzzz ## zzzzqqq" in any loaded source');
    expect(folded).not.toContain('\n## zzzzqqq');
  });

  it('carries every source and its matches in its structured content', async () => {
    const result = await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'get started ios' } });
    const structured = result.structuredContent as {
      topic: string;
      message: string;
      sources: Array<{ source: string; status: string; matches: Array<{ url: string }> }>;
    };
    expect(structured.topic).toBe('get started');
    expect(structured.sources.map((s) => s.source)).toEqual(DOCS.sources.map((s) => s.id));
    const developer = structured.sources.find((s) => s.source === 'developer')!;
    expect(developer.status).toBe('matched');
    expect(developer.matches[0]!.url).toBe('https://developer.magiclane.com/docs/guides/get-started');
    expect(structured.sources.some((s) => s.status === 'no match' && s.matches.length === 0)).toBe(true);
    expect(structured.message).toMatch(/^\d+ of 7 sources have pages on "get started"\.$/);
    resetCaches();
    seedIndex('developer', DEVELOPER_LLMS);
    ({ restore } = stubFetch({}));
    const partial = (await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'get started' } }))
      .structuredContent as typeof structured;
    expect(partial.sources.find((s) => s.source === 'android')).toMatchObject({
      status: 'index not loaded',
      reason: expect.stringContaining('HTTP 404'),
      matches: [],
    });
  });

  it("says when a dropped platform word could not be checked against its platform's titles", async () => {
    resetCaches();
    seedIndex('flutter', '- [SDK Automatic Activation](/docs/flutter/sdk-auto-activation.md): Activate the SDK.\n');
    seedIndex('ios', sdkIndexFixture('ios'));
    ({ restore } = stubFetch({}));
    const result = await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'Android Auto' } });
    const structured = result.structuredContent as {
      topic: string;
      sources: Array<{ status: string }>;
      unverified: Array<{ word: string; source: string }>;
    };
    expect(structured.topic).toBe('Auto');
    expect(structured.unverified).toEqual([{ word: 'Android', source: 'android' }]);
    expect(textOf(result)).toContain(
      '"Android" was read as a platform name and left out of the topic; whether it is part of a feature name ' +
        'instead (such as "Android Auto") could not be checked, because the android index could not be loaded.'
    );
    // Only the platform whose index failed is in doubt.
    const ios = await t.client.callTool({
      name: 'find_across_sdks',
      arguments: { query: 'markers on iOS vs Android' },
    });
    expect(textOf(ios)).not.toContain('"iOS" was read');
    expect(textOf(ios)).toContain('"Android" was read as a platform name');
    expect((ios.structuredContent as { unverified: unknown[] }).unverified).toEqual([
      { word: 'Android', source: 'android' },
    ]);
  });

  it('keeps the platform names as the topic when only stopwords would be left', async () => {
    const result = await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'what is flutter' } });
    const structured = result.structuredContent as { topic: string; unverified: unknown[] };
    expect(structured.topic).toBe('what is flutter');
    expect(structured.unverified).toEqual([]);
    expect(textOf(result)).toContain('"what is flutter"');
    expect(topicOf('ios vs android')).toBe('ios vs android');
    expect(topicOf('markers on ios vs android')).toBe('markers');
  });

  it('shows which sources could not be loaded, and errors only when none could', async () => {
    resetCaches();
    seedIndex('flutter', FLUTTER_LLMS);
    ({ restore } = stubFetch({}));
    const partial = await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'add markers' } });
    expect(isError(partial)).toBe(false);
    expect(textOf(partial)).toContain('(source: android)\n\n(index not loaded: HTTP 404');
    expect(textOf(partial)).toContain('6 source(s) could not be loaded');
    // The page contents of every source failed too: a page whose index entry lacks a word of the topic could
    // not be checked against its text.
    expect(textOf(partial)).toContain(
      'The page contents (llms-full.txt) of developer, flutter, android, ios, cpp, typescript, cloud-rest-api could ' +
        'not be loaded, so a page there that lacks a word of the topic'
    );
    expect(failedSourcesOf(partial)).toHaveLength(13);
    // Nothing matched, so no block names a failed source: the note lists each one with its reason itself.
    const nothing = await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'qqqzzz' } });
    expect(textOf(nothing)).toContain('No documentation matched');
    expect(textOf(nothing)).toContain('## Sources not loaded');
    expect(textOf(nothing)).toContain('13 documentation file(s) could not be loaded');
    for (const id of ['android', 'ios', 'cpp', 'typescript', 'cloud-rest-api', 'developer']) {
      expect(textOf(nothing)).toContain(`- ${id} index (llms.txt): HTTP 404`);
      expect(textOf(nothing)).toContain(`- ${id} page contents (llms-full.txt): HTTP 404`);
    }
    expect(textOf(nothing)).not.toContain('(see above)');
    resetCaches();
    const none = await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'add markers' } });
    expect(isError(none)).toBe(true);
  });

  it('rejects an out-of-range limitPerSource and an over-long query with validation errors', async () => {
    expect(
      isError(await t.client.callTool({ name: 'find_across_sdks', arguments: { query: 'x', limitPerSource: 9 } }))
    ).toBe(true);
    const long = await t.client.callTool({
      name: 'find_across_sdks',
      arguments: { query: 'x'.repeat(LIMITS.maxQueryChars + 1) },
    });
    expect(isError(long)).toBe(true);
  });
});

describe('answersTopic', () => {
  const hit = (fields: Partial<ScoredEntry>): ScoredEntry => ({
    title: 'Page',
    url: 'https://developer.magiclane.com/docs/guides/page.md',
    path: '/docs/guides/page.md',
    description: '',
    section: '',
    source: 'developer',
    score: 1,
    matched: 2,
    matchedOwn: 2,
    queryWords: 2,
    coversRarestWord: true,
    rarestInHeading: true,
    rarestIsCommon: false,
    coverage: 1,
    topicWords: 3,
    matchedTopic: 3,
    matchedTopicOwn: 3,
    matchedTitle: 0,
    headedElsewhere: true,
    headedHere: true,
    ownElsewhere: true,
    rarestNamedEarly: false,
    rarest: 'way',
    missingTopic: [],
    ...fields,
  });
  // A page's own text (llms-full.txt), by its words.
  const text = (words: string): ReturnType<typeof wordStats> => wordStats(words);

  it('needs half the topic words, and every word for a feature name', () => {
    expect(answersTopic(hit({ matched: 2, queryWords: 4, topicWords: 4, matchedTopic: 2 }), false)).toBe(true);
    expect(answersTopic(hit({ matched: 1, queryWords: 3, topicWords: 3, matchedTopic: 1 }), false)).toBe(false);
    // Action words are not the topic: "show me how to add markers" is answered by a page on markers.
    expect(answersTopic(hit({ matched: 1, matchedOwn: 1, queryWords: 3, topicWords: 1, matchedTopic: 1 }), false)).toBe(
      true
    );
    expect(answersTopic(hit({ matched: 1, queryWords: 2 }), true)).toBe(false);
  });

  it("needs every topic word of a short topic in the page's own words, and a heading for a one-word topic", () => {
    // "recorder bookmarks" → "Route Bookmarks": half the words, but a topic word is missing.
    const short = { matched: 1, queryWords: 2, topicWords: 2, matchedTopic: 1, matchedTopicOwn: 1 };
    expect(answersTopic(hit(short), false)).toBe(false);
    expect(answersTopic(hit({ ...short, matched: 2, matchedTopic: 2, matchedTopicOwn: 2 }), false)).toBe(true);
    // "handle route events" → "Social Event Voting" under Routing & Navigation: of three words the page's own
    // title and description hold "event" alone, the section says "route", and the Routing guides are the pages
    // about routes.
    const sectionOnly = { matched: 2, matchedOwn: 1, queryWords: 3, topicWords: 2, matchedTopic: 2 };
    expect(answersTopic(hit({ ...sectionOnly, matchedTopicOwn: 1, headedElsewhere: false }), false)).toBe(false);
    expect(answersTopic(hit({ ...sectionOnly, matchedTopicOwn: 2, headedElsewhere: false }), false)).toBe(true);
    // "record positions": the Recorder, under Positioning & Sensors, holds half of the two words itself.
    expect(answersTopic(hit({ ...short, matched: 2, matchedTopic: 2, headedElsewhere: false }), false)).toBe(true);
    // "build a route" → "Get started with routing": the action word may be missing, the topic word not.
    expect(
      answersTopic(hit({ matched: 1, queryWords: 2, topicWords: 1, matchedTopic: 1, matchedTopicOwn: 1 }), false)
    ).toBe(true);
    // "recorder" → a page whose description says "order records": a mention, not the page.
    expect(
      answersTopic(hit({ matched: 1, queryWords: 1, topicWords: 1, matchedTopic: 1, rarestInHeading: false }), false)
    ).toBe(false);
    expect(answersTopic(hit({ matched: 1, queryWords: 1, topicWords: 1, matchedTopic: 1 }), false)).toBe(true);
    // "ios vs android": each platform answers for its own name.
    expect(answersTopic(hit(short), false, true)).toBe(true);
  });

  it("needs half the words in the page's own title or description, not only in its section", () => {
    expect(answersTopic(hit({ matched: 2, matchedOwn: 1, queryWords: 3, matchedTopic: 2 }), false)).toBe(false);
    expect(answersTopic(hit({ matched: 2, matchedOwn: 1, queryWords: 2, topicWords: 2, matchedTopic: 2 }), false)).toBe(
      true
    );
    // A feature name needs every word anywhere, as before.
    expect(answersTopic(hit({ matched: 2, matchedOwn: 0, queryWords: 2 }), true)).toBe(true);
  });

  it('needs the most specific word in a heading, or in the description with every other word', () => {
    expect(answersTopic(hit({ coversRarestWord: false }), false)).toBe(false);
    // "configure routing" → a page that mentions routing in its description only.
    expect(answersTopic(hit({ rarestInHeading: false, matched: 1 }), false)).toBe(false);
    expect(answersTopic(hit({ rarestInHeading: false }), false)).toBe(true);
  });

  it('needs every word when even the most specific one is common', () => {
    // "update maps" → "Create a Map Style".
    expect(answersTopic(hit({ rarestIsCommon: true, matched: 1 }), false)).toBe(false);
    expect(answersTopic(hit({ rarestIsCommon: true }), false)).toBe(true);
  });

  it('lets a short topic miss a word no page is headed with, and a described word head no page', () => {
    // "landmark store" → "Landmarks": "store" heads no page, and the page's own text names it.
    const missingOne = { matched: 1, queryWords: 2, topicWords: 2, matchedTopic: 1, matchedTopicOwn: 1 };
    const headsNoPage = { headedElsewhere: false, headedHere: false, ownElsewhere: false, missingTopic: ['stor'] };
    const store = text('Landmarks live in a landmark store; create the store first.');
    expect(answersTopic(hit({ ...missingOne, ...headsNoPage }), false, false, false, store)).toBe(true);
    // Not when its text names the word once in passing or not at all, or is not loaded: "route caching" →
    // "Get started with routing".
    expect(answersTopic(hit({ ...missingOne, ...headsNoPage }), false, false, false, text('One store.'))).toBe(false);
    expect(answersTopic(hit({ ...missingOne, ...headsNoPage }), false)).toBe(false);
    // A word that says what to do is no missing word ("up" in "set up navigation"): nothing to look for.
    expect(answersTopic(hit({ ...missingOne, ...headsNoPage, missingTopic: [] }), false)).toBe(true);
    // "recorder bookmarks" → "Route Bookmarks": "recorder" heads other pages of its source, so this is not the
    // page about it; a word only another source heads ("generate" in C++'s "Generate Territories") is no such page.
    expect(answersTopic(hit({ ...missingOne, ...headsNoPage, headedHere: true }), false, false, false, store)).toBe(
      false
    );
    expect(
      answersTopic(hit({ ...missingOne, ...headsNoPage, headedElsewhere: true }), false, false, false, store)
    ).toBe(true);
    // "api key" → "Vector Tiles API": "key" heads no page, but a page matching "API" alone is no answer.
    expect(answersTopic(hit({ ...missingOne, ...headsNoPage }), false, false, true, store)).toBe(false);
    // "show traffic on the map" → "Traffic Events": a common word ("map") found in the section is enough
    // (ownElsewhere false); "handle route events" → "Social Event Voting" under Routing & Navigation: "route"
    // heads other pages, and the section is all that says it (ownElsewhere true).
    const sectionOnly = { matched: 2, matchedOwn: 1, queryWords: 3, topicWords: 2, matchedTopic: 2 };
    const inSection = { ...sectionOnly, matchedTopicOwn: 1, headedElsewhere: false };
    expect(answersTopic(hit({ ...inSection, ownElsewhere: false }), false)).toBe(true);
    expect(answersTopic(hit({ ...inSection, ownElsewhere: true }), false)).toBe(false);
    // "waypoints" → a routing guide whose description names waypoints at once and whose text names them again;
    // not one that mentions them in passing, in its description or its text.
    const described = { matched: 1, queryWords: 1, topicWords: 1, matchedTopic: 1, rarestInHeading: false };
    const waypoints = text('Add waypoints; the route runs through the waypoints.');
    const early = { ...described, headedElsewhere: false, rarest: 'waypoint', rarestNamedEarly: true };
    expect(answersTopic(hit(early), false, false, false, waypoints)).toBe(true);
    expect(answersTopic(hit(early), false, false, false, text('One waypoint.'))).toBe(false);
    expect(answersTopic(hit({ ...early, rarestNamedEarly: false }), false, false, false, waypoints)).toBe(false);
    // "recorder" → "order records": the word heads other pages, however early the description uses it.
    expect(answersTopic(hit({ ...early, headedElsewhere: true }), false, false, false, waypoints)).toBe(false);
    // "update maps" → "Update Content": the title holds the query's action word, the description the topic.
    const update = { matched: 2, queryWords: 2, topicWords: 1, matchedTopic: 1, rarestInHeading: false };
    expect(answersTopic(hit({ ...update, rarestIsCommon: true, matchedTitle: 1 }), false)).toBe(true);
    expect(answersTopic(hit({ ...update, rarestIsCommon: true, matchedTitle: 0 }), false)).toBe(false);
  });
});
