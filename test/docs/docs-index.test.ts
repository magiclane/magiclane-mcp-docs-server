/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
// cspell:ignore Köln köln Straßen straßen straße über styl exampl geocod recognised
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveSection,
  loadIndex,
  namesApiKey,
  newInternTable,
  parseLlmsTxt,
  platformPreference,
  platformScope,
  platformSources,
  queryWordSpans,
  searchIndex,
  seedIndex,
  selectSources,
  sourceRoot,
  stem,
  toAbsoluteUrl,
  tokenize,
  tokenizeQuery,
  topicInTitle,
  topicTokens,
  wordHit,
  wordStats,
} from '../../src/docs/docs-index.js';
import { DOCS, LIMITS } from '../../src/config/constants.js';
import type { DocSource } from '../../src/config/constants.js';
import {
  DEVELOPER_LLMS,
  DEVELOPER_SOURCE,
  FLUTTER_LLMS,
  FLUTTER_SOURCE,
  resetCaches,
  seedFixtures,
  stubFetch,
} from '../helpers.js';

describe('parseLlmsTxt', () => {
  const entries = parseLlmsTxt(FLUTTER_LLMS, FLUTTER_SOURCE);

  it('parses all list entries including ones without descriptions', () => {
    expect(entries).toHaveLength(7);
    expect(entries[3]!.title).toBe('Draw Route');
    expect(entries[3]!.description).toBe('');
  });

  it('resolves relative URLs against the developer site and keeps the path', () => {
    expect(entries[1]!.url).toBe(
      'https://developer.magiclane.com/docs/flutter/examples/routing-navigation/calculate-route.md'
    );
    expect(entries[1]!.path).toBe('/docs/flutter/examples/routing-navigation/calculate-route.md');
  });

  it('derives sections from the URL, naming categories after their own index page', () => {
    expect(entries[0]!.section).toBe('Examples'); // the category page itself
    expect(entries[1]!.section).toBe('Examples › Routing & Navigation');
    expect(entries[5]!.section).toBe('Examples › Maps & 3D Scene');
    expect(entries[6]!.section).toBe('Guides › Core'); // no "Core" page listed: slug prettified
  });

  it('records the source id', () => {
    expect(entries.every((e) => e.source === FLUTTER_SOURCE.id)).toBe(true);
  });

  it('accepts * bullets and ignores lines that are not list items with links', () => {
    const parsed = parseLlmsTxt('plain text\n- no link here\n* [Star](/docs/x/y.md)\n', DEVELOPER_SOURCE);
    expect(parsed.map((e) => e.title)).toEqual(['Star']);
  });

  it('drops entries that link off the documentation host', () => {
    const withForeignLink = `## Docs

- [Legit](/docs/guides/a.md): on-host.
- [Injected](https://evil.example/steal): injected link.
- [Cleartext](http://developer.magiclane.com/docs/b.md): downgraded scheme.
`;
    const parsed = parseLlmsTxt(withForeignLink, DEVELOPER_SOURCE);
    expect(parsed.map((e) => e.title)).toEqual(['Legit']);
  });
});

describe('sourceRoot and deriveSection', () => {
  it('roots the developer guides at /docs/ and an SDK at /docs/<id>/', () => {
    expect(sourceRoot(DEVELOPER_SOURCE)).toBe('/docs/');
    expect(sourceRoot(FLUTTER_SOURCE)).toBe('/docs/flutter/');
  });

  it('labels every directory below the root, preferring index titles', () => {
    const titles = new Map([['/docs/guides/map-studio.md', 'Map Studio']]);
    expect(deriveSection('/docs/guides/map-studio/create-a-map-style.md', '/docs/', titles)).toBe(
      'Guides › Map Studio'
    );
    expect(deriveSection('/docs/guides/get-started.md', '/docs/', titles)).toBe('Guides');
  });

  it('copes with a path outside the root and with empty slug parts', () => {
    expect(deriveSection('/elsewhere/a--b/page.md', '/docs/', new Map())).toBe('Elsewhere › A B');
    expect(deriveSection('/docs/page.md', '/docs/', new Map())).toBe('');
  });
});

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, drops short words and stopwords, stems plurals', () => {
    expect(tokenize('How do I add Markers to the map?')).toEqual(['add', 'marker', 'map']);
    expect(tokenize('Magic Lane docs: C++ routes & categories')).toEqual(['magic', 'lane', 'c++', 'rout', 'category']);
    // Letters of any script are word characters; accents do not split a word.
    expect(tokenize('Straßen über Köln')).toEqual(['straßen', 'über', 'köln']);
  });

  it('de-duplicates tokens', () => {
    expect(tokenize('route Route ROUTES routing routed')).toEqual(['rout']);
  });

  it('caps query words', () => {
    const many = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    expect(tokenize(many)).toHaveLength(40);
    expect(tokenizeQuery(many)).toHaveLength(LIMITS.maxQueryTokens);
  });
});

describe('words of the v15 phrasing classes', () => {
  it('takes no word for a platform or a stem just because Object.prototype has it ("constructor")', () => {
    expect(platformSources('constructor toString valueOf')).toEqual([]);
    expect(tokenize('constructor')).toEqual(['constructor']);
    expect(stem('constructor')).toBe('constructor');
  });

  it('keeps a dotted version number as one word, in pages and queries alike', () => {
    expect(tokenize('Migrate to 3.1.4')).toEqual(['migrat', '3.1.4']);
    expect(platformScope('flutter migrate to 3.1.4', [])).toEqual({ topic: 'migrate to 3.1.4', sources: ['flutter'] });
    // A "v" before it, in either case: one word, and the same version.
    for (const written of ['v2.27.0', 'V2.27.0']) {
      expect(
        queryWordSpans(`migrate to ${written}`).map((s) => s.word),
        written
      ).toEqual(['migrate', 'to', written]);
      expect(tokenize(`migrate to ${written}`), written).toEqual(['migrat', '2.27']);
    }
    expect(queryWordSpans('V2 and V2.27.0').map((s) => s.word)).toEqual(['V2', 'and', 'V2.27.0']);
  });

  it('takes a version no page names for its family, the versions it begins', () => {
    const cloud = parseLlmsTxt(
      '- [Migrate to 1.1.1](/docs/cloud-rest-api/migrate-to-1-1-1.md): The changes in version 1.1.1.\n' +
        '- [Migrate to 1.1.2](/docs/cloud-rest-api/migrate-to-1-1-2.md): The changes in version 1.1.2.\n' +
        '- [Migrate to 3.0.0](/docs/cloud-rest-api/migrate-to-3-0-0.md): The changes in version 3.0.0.\n' +
        '- [Migrate to 3.0.4](/docs/cloud-rest-api/migrate-to-3-0-4.md): The changes in version 3.0.4.\n',
      DOCS.sources.find((s) => s.id === 'cloud-rest-api')!
    );
    // No page names 1.1.0: "v1.1.x" asks for the migration guides of 1.1.1 and 1.1.2, matched in their titles.
    const family = searchIndex(cloud, 'v1.1.x breaking changes', 4);
    expect(family.map((h) => h.title)).toEqual(['Migrate to 1.1.1', 'Migrate to 1.1.2']);
    expect(family[0]).toMatchObject({ matchedTitle: 1, missingTopic: ['break'] });
    // A version a page names is that version alone: "3.0" is 3.0.0, and 3.0.4 matches only "migrate".
    const exact = searchIndex(cloud, 'migrate to 3.0', 4);
    expect(exact[0]).toMatchObject({ title: 'Migrate to 3.0.0', matchedTitle: 2 });
    expect(exact.find((h) => h.title === 'Migrate to 3.0.4')).toMatchObject({ matchedTitle: 1 });
  });

  it('drops how a question is put ("what is the best way to", "is it possible to", "please help me")', () => {
    expect(tokenize('what is the best way to add markers')).toEqual(['add', 'marker']);
    expect(tokenize('is it possible to calculate a route')).toEqual(tokenize('calculate route'));
    expect(tokenize('please help me, I need the recommended way')).toEqual([]);
  });

  it('drops a request verb before "me" or "us" ("show me how to"), but not the action asked for ("show traffic")', () => {
    expect(tokenize('could you show me how to use reverse geocoding')).toEqual(['revers', 'geocod']);
    expect(tokenize('Show us how to add markers')).toEqual(['add', 'marker']);
    expect(tokenize('give me an example of routing')).toEqual(['exampl', 'rout']);
    expect(tokenize('walk me through adding markers')).toEqual(['add', 'marker']);
    expect(tokenize('can you walk us through routing')).toEqual(['rout']);
    // "through" elsewhere is a word like any other.
    expect(tokenize('route through the tunnel')).toEqual(['rout', 'through', 'tunnel']);
    expect(tokenize('show traffic')).toEqual(['show', 'traffic']);
    expect(tokenize('show the current position')).toEqual(['show', 'current', 'position']);
    // The title that is the query is still recognised in its own words.
    const pages = parseLlmsTxt(
      '- [Markers](/docs/flutter/guides/core/markers.md): Markers on the map.\n' +
        '- [Marker Clustering](/docs/flutter/examples/clustering.md): Cluster markers on the map.\n',
      FLUTTER_SOURCE
    );
    expect(searchIndex(pages, 'show me markers', 2).map((h) => h.title)).toEqual(['Markers', 'Marker Clustering']);
    expect(searchIndex(pages, 'show me markers', 1)[0]!.score).toBe(searchIndex(pages, 'markers', 1)[0]!.score);
  });

  it('keeps "project" apart from "projection": an app project is not a coordinate projection', () => {
    expect(stem('projection')).not.toBe(stem('project'));
    expect(tokenize('projections')).toEqual(tokenize('projection'));
    const pages = [
      ...parseLlmsTxt(
        '- [Projections](/docs/flutter/guides/positioning/projections.md): Convert coordinates between projections.\n' +
          '- [Integrate the SDK](/docs/flutter/guides/get-started/integrate-sdk.md): Add the package to your project.\n',
        FLUTTER_SOURCE
      ),
      ...parseLlmsTxt(
        '- [Get Started](/docs/guides/get-started.md): Create your account and your first project.\n',
        DEVELOPER_SOURCE
      ),
    ];
    expect(searchIndex(pages, 'add the sdk to my project', 1)[0]!.title).toBe('Integrate the SDK');
    expect(searchIndex(pages, 'create a project', 1)[0]!.title).toBe('Get Started');
    expect(searchIndex(pages, 'projections', 1)[0]!.title).toBe('Projections');
    // The cost, accepted: "project wgs84 coordinates" no longer reads as projections, so the Projections guide
    // is found by "coordinates" alone — listed by search_docs, but no match for find_across_sdks, which needs
    // the query's most specific word and half of its topic words.
    expect(searchIndex(pages, 'project wgs84 coordinates', 1)[0]).toMatchObject({
      title: 'Projections',
      matched: 1,
      queryWords: 3,
      coversRarestWord: false,
    });
  });

  it('reads the setup pages as adding the SDK package to the project, whatever their descriptions say', () => {
    // The published descriptions: a heading ("Step 1: Add the package"), or the install steps.
    const pages = [
      ...parseLlmsTxt(
        '- [Integrate the SDK](/docs/flutter/guides/get-started/integrate-sdk.md): Step 1: Add the package\n' +
          '- [Coding with AI](/docs/flutter/guides/coding-with-ai.md): Set up your AI assistant for a Flutter project.\n' +
          '- [Offline](/docs/flutter/guides/offline.md): Download maps and keep them up to date in your project.\n',
        FLUTTER_SOURCE
      ),
      ...parseLlmsTxt(
        '- [Integrate the SDK](/docs/android/guides/get-started/integrate-sdk.md): This guide describes the steps to ' +
          'install the most recent version of the Maps SDK for Android and configure your Android app to use the SDK.\n' +
          '- [Get started with Compose](/docs/android/guides/compose/get-started.md): Add the Compose artifacts to ' +
          'your project.\n',
        DOCS.sources.find((s) => s.id === 'android')!
      ),
      ...parseLlmsTxt(
        '- [Get Started](/docs/guides/get-started.md): Create your account and your first project.\n',
        DEVELOPER_SOURCE
      ),
    ];
    const titles = (query: string): string[] => searchIndex(pages, query, 3).map((h) => h.title);
    expect(titles('add project').slice(0, 2)).toEqual(['Integrate the SDK', 'Integrate the SDK']);
    expect(titles('add dependency gradle')[0]).toBe('Integrate the SDK');
    expect(titles('install the package')[0]).toBe('Integrate the SDK');
    // About a topic of its own, the setup page's other words do not count: only "Maps SDK" in the Android
    // description matches, and Flutter's page ("Add the package") matches nothing of the topic.
    const offline = searchIndex(pages, 'add offline maps to my project', 10);
    expect(offline[0]!.title).toBe('Offline');
    const setupHits = offline.filter((h) => h.title === 'Integrate the SDK');
    expect(setupHits.map((h) => h.source)).toEqual(['android']);
    expect(setupHits[0]).toMatchObject({ matched: 1, matchedTopic: 1 });
    // The account's Get Started creates a project; the setup pages only add to one.
    expect(titles('create a project')[0]).toBe('Get Started');
    expect(titles('project')[0]).toBe('Get Started');
  });

  it('folds the tool and the noun into their verb, and takes "integrate" for a topic word', () => {
    expect(stem('recorder')).toBe(stem('record'));
    expect(stem('integration')).toBe(stem('integrate'));
    expect(stem('rotation')).toBe(stem('rotate'));
    expect(stem('navigation')).toBe(stem('navigate'));
    const pages = parseLlmsTxt(
      '- [Integrate the SDK](/docs/flutter/integrate.md): Add the SDK to your app.\n' +
        '- [Hello App](/docs/flutter/hello.md): Your first app with the SDK.\n',
      FLUTTER_SOURCE
    );
    expect(searchIndex(pages, 'sdk integration', 1)[0]!.title).toBe('Integrate the SDK');
  });
});

describe('stem', () => {
  it('folds plurals but leaves short words and -ss alone', () => {
    expect(stem('markers')).toBe('marker');
    expect(stem('cities')).toBe('city');
    expect(stem('gps')).toBe('gps');
    expect(stem('class')).toBe('class');
    expect(stem('ios')).toBe('ios');
  });

  it('folds "-es" plurals after s, x, ch and sh, consistently with the singular', () => {
    expect(stem('addresses')).toBe('address');
    expect(stem('searches')).toBe('search');
    expect(stem('boxes')).toBe('box');
    expect(stem('crashes')).toBe('crash');
    // Query and page words only need to meet: "cache"/"caches", "size"/"sizes".
    expect(stem('caches')).toBe(stem('cache'));
    expect(stem('sizes')).toBe(stem('size'));
    expect(stem('axe')).toBe('axe'); // short words stay
  });

  it('folds -ing, -ed, doubled consonants and a trailing e the same way on both sides', () => {
    for (const group of [
      ['route', 'routes', 'routed', 'routing'],
      ['calculate', 'calculated', 'calculating'],
      ['geocode', 'geocoding'],
      ['embed', 'embedded', 'embedding'],
      ['run', 'running'],
      ['setting', 'settings'],
      ['style', 'styles'],
      ['follow', 'follows', 'followed'],
      ['token', 'tokens', 'key', 'keys'], // one credential, two names in the docs
      ['initialize', 'initialized'],
      ['entry', 'entries'],
    ]) {
      expect(new Set(group.map(stem)).size, group.join('/')).toBe(1);
    }
    expect(stem('routing')).toBe('rout');
    // Short words and words that only look inflected are left alone.
    for (const word of ['speed', 'need', 'thing', 'sdk', 'ios', 'gps', 'class', 'size', 'type']) {
      expect(stem(word), word).toBe(word);
    }
    // Words whose -ing/-ed form means something else here keep it: "the
    // following", "get started", "settings" are not "follow", "start", "set".
    for (const [word, base] of [
      ['following', 'follow'],
      ['started', 'start'],
      ['settings', 'set'],
      ['string', 'str'],
    ]) {
      expect(stem(word as string), word).not.toBe(stem(base as string));
    }
  });
});

describe('following and installation', () => {
  it('reads "following" as the verb, except in "the following"', () => {
    expect(tokenize('following the position')).toEqual(['follow', 'position']);
    expect(tokenize('see the following')).toEqual(['see', 'following']);
    expect([...wordStats('the following steps, following the route').keys()]).toEqual([
      'following',
      'step',
      'follow',
      'rout',
    ]);
  });

  it('folds "installation" into "install"', () => {
    expect(tokenize('installation')).toEqual(tokenize('install'));
  });

  it('folds the nouns the docs use for their verbs: simulation, calculation, optimization, configuration', () => {
    for (const [noun, verb] of [
      ['simulation', 'simulate'],
      ['calculation', 'calculating'],
      ['optimization', 'optimize'],
      ['configuration', 'configure'],
    ])
      expect(tokenize(noun)).toEqual(tokenize(verb as string));
  });
});

describe('platformScope', () => {
  const titles = ['Android Auto Navigation', 'GPX Route Simulation Java', 'Swift Package Manager'];

  it('splits platform names off a query: they say where to look', () => {
    expect(platformScope('get started flutter', titles)).toEqual({ topic: 'get started', sources: ['flutter'] });
    expect(platformScope('C++ routing', titles)).toEqual({ topic: 'routing', sources: ['cpp'] });
    expect(platformScope('ios vs android markers', titles)).toEqual({ topic: 'markers', sources: ['ios', 'android'] });
    // The qualifier and function words a dropped platform name leaves at the ends go with it.
    expect(platformScope('flutter sdk routing', titles)).toEqual({ topic: 'routing', sources: ['flutter'] });
    expect(platformScope('routing with the android sdk', titles)).toEqual({ topic: 'routing', sources: ['android'] });
    // "for flutter" names no feature, though every SDK has a "Maps SDK for <Platform>" page.
    expect(platformScope('routing for flutter', ['Maps SDK for Flutter'])).toEqual({
      topic: 'routing',
      sources: ['flutter'],
    });
    // One other word in a title is not a feature name.
    expect(platformScope('navigation android', titles)).toEqual({ topic: 'navigation', sources: ['android'] });
    // Only the words next to the platform name go with it, and the "API" of
    // the credential's name ("api key", "api token") never does: it is the
    // topic's own. Any other "API" names the platform, like "SDK", wherever
    // it stands: "routing api flutter" and "flutter routing api" ask for routing.
    expect(platformScope('api key flutter', titles)).toEqual({ topic: 'api key', sources: ['flutter'] });
    expect(platformScope('flutter api key', titles)).toEqual({ topic: 'api key', sources: ['flutter'] });
    expect(platformScope('flutter sdk api key', titles)).toEqual({ topic: 'api key', sources: ['flutter'] });
    expect(platformScope('android api token', titles)).toEqual({ topic: 'api token', sources: ['android'] });
    expect(platformScope('routing api flutter', titles)).toEqual({ topic: 'routing', sources: ['flutter'] });
    expect(platformScope('flutter routing api', titles)).toEqual({ topic: 'routing', sources: ['flutter'] });
    expect(platformScope('navigation api for android', titles)).toEqual({ topic: 'navigation', sources: ['android'] });
    expect(platformScope('ios sdk api routing', titles)).toEqual({ topic: 'routing', sources: ['ios'] });
    expect(platformScope('key flutter api', titles)).toEqual({ topic: 'key', sources: ['flutter'] });
    expect(platformScope('api flutter key', titles)).toEqual({ topic: 'key', sources: ['flutter'] });
    // The Cloud's "API" is its product name, dropped with it — but not the credential's.
    expect(platformScope('rest api authentication', titles)).toEqual({
      topic: 'authentication',
      sources: ['cloud-rest-api'],
    });
    expect(platformScope('rest api key', titles)).toEqual({ topic: 'api key', sources: ['cloud-rest-api'] });
    expect(platformScope('cloud api token', titles)).toEqual({ topic: 'api token', sources: ['cloud-rest-api'] });
    expect(platformScope('where do I get a rest api key', titles)).toEqual({
      topic: 'get api key',
      sources: ['cloud-rest-api'],
    });
    for (const q of ['rest api key', 'api token flutter', 'where do I get an API key'])
      expect(namesApiKey(q), q).toBe(true);
    for (const q of ['rest api', 'routing api android', 'key flutter api']) expect(namesApiKey(q), q).toBe(false);
    // The query is a page's title: the page is the topic, platform name and all.
    expect(platformScope('maps sdk for flutter', ['Maps SDK for Flutter', ...titles])).toEqual({
      topic: 'maps sdk for flutter',
      sources: ['flutter'],
    });
    // Function words left at the ends of the topic go too.
    expect(platformScope('what flutter routing is', titles)).toEqual({ topic: 'routing', sources: ['flutter'] });
    expect(platformScope('is routing flutter what', titles)).toEqual({ topic: 'routing', sources: ['flutter'] });
  });

  it('keeps a platform word that is part of a feature name, and still looks only there', () => {
    expect(platformScope('Android Auto', titles)).toEqual({ topic: 'Android Auto', sources: ['android'] });
    expect(platformScope('swift package manager', titles)).toEqual({
      topic: 'swift package manager',
      sources: ['ios'],
    });
    expect(platformScope('java route simulation', titles)).toEqual({
      topic: 'java route simulation',
      sources: ['android'],
    });
  });

  it('keeps the platform names as the topic when nothing else is left, looked up in their own pages', () => {
    expect(platformScope('C++', titles)).toEqual({ topic: 'C++', sources: ['cpp'] });
    expect(platformScope('flutter android', titles)).toEqual({
      topic: 'flutter android',
      sources: ['flutter', 'android'],
    });
    expect(platformScope('what is flutter', titles)).toEqual({ topic: 'what is flutter', sources: ['flutter'] });
    expect(platformScope('ios vs android', titles)).toEqual({ topic: 'ios vs android', sources: ['ios', 'android'] });
    expect(platformScope('is there a flutter sdk', titles)).toEqual({
      topic: 'is there a flutter sdk',
      sources: ['flutter'],
    });
    expect(platformScope('REST API', titles)).toEqual({ topic: 'REST API', sources: ['cloud-rest-api'] });
  });

  it('reads an everyday word as a platform name only when qualified', () => {
    for (const q of ['map studio web editor', 'cloud account api key', 'react to route events', 'compose markers']) {
      expect(platformScope(q, titles), q).toEqual({ topic: q, sources: [] });
    }
    expect(platformScope('web sdk markers', titles)).toEqual({ topic: 'markers', sources: ['typescript'] });
    expect(platformScope('routing REST API', titles)).toEqual({ topic: 'routing', sources: ['cloud-rest-api'] });
    expect(platformScope('cloud rest geocoding', titles)).toEqual({ topic: 'geocoding', sources: ['cloud-rest-api'] });
    expect(platformScope('typescript web map', titles)).toEqual({ topic: 'map', sources: ['typescript'] });
    // Unqualified, it is a search word: the Compose pages match it by name.
    expect(platformScope('compose ui', [...titles, 'Compose UI'])).toEqual({ topic: 'compose ui', sources: [] });
  });

  it('reads an unqualified web, cloud, rest or compose as a preference for that platform, not a filter', () => {
    expect(platformPreference('cloud geocoding')).toEqual({ words: ['cloud'], sources: ['cloud-rest-api'] });
    expect(platformPreference('web markers')).toEqual({ words: ['web'], sources: ['typescript'] });
    expect(platformPreference('compose navigation')).toEqual({ words: ['compose'], sources: ['android'] });
    expect(platformPreference('rest area')).toEqual({ words: ['rest'], sources: ['cloud-rest-api'] });
    // In a phrase of its own the word still weighs little, but leans towards no platform.
    expect(platformPreference('rest of the route')).toEqual({ words: ['rest'], sources: [] });
    expect(platformPreference('compose a message')).toEqual({ words: ['compose'], sources: [] });
    expect(platformPreference('geocoding cloud')).toEqual({ words: ['cloud'], sources: ['cloud-rest-api'] });
    // Qualified it is a filter; alone it is the search word; "react" is a verb.
    for (const q of ['cloud api geocoding', 'cloud', 'the web', 'react to route events', 'web sdk', 'add markers']) {
      expect(platformPreference(q), q).toEqual({ words: [], sources: [] });
    }
  });

  it('names the sources from the words alone, so they can be loaded before the titles are known', () => {
    expect(platformSources('markers on iOS')).toEqual(['ios']);
    expect(platformSources('ios vs android markers')).toEqual(['ios', 'android']);
    expect(platformSources('Android Auto')).toEqual(['android']);
    expect(platformSources('C++')).toEqual(['cpp']);
    expect(platformSources('add markers')).toEqual([]);
    expect(platformSources('cloud account')).toEqual([]);
  });
});

describe('wordStats', () => {
  it('counts a word at most 10 times, so a long page cannot win on repetition alone', () => {
    expect(wordHit(wordStats('route '.repeat(40)).get('rout')!).count).toBe(10);
  });

  it("interns a source's words in the table of its current parse, dropped with the copy it belonged to", () => {
    const first = newInternTable('x');
    const a = wordStats('zebra crossing', 'x');
    const b = wordStats('a zebra', 'x');
    expect(first.size).toBe(2);
    expect([...a.keys()][0]).toBe([...b.keys()][0]); // one string, shared by the pages
    const second = newInternTable('x'); // the source parsed again: a fresh table
    wordStats('zebra', 'x');
    expect(second.size).toBe(1);
    expect(first.size).toBe(2); // the old one is no longer written to
    // A page of no known source, or with no source given, gets a table of its own.
    expect(wordStats('zebra zebra', 'unknown').get('zebra')).toBeDefined();
  });
});

describe('searchIndex', () => {
  const flutter = (lines: string[]) => parseLlmsTxt(lines.join('\n'), FLUTTER_SOURCE);

  it('weighs action words like "create" at half, and does not count them against a page about the topic', () => {
    const pages = flutter([
      '- [Overlays](/docs/flutter/guides/core/overlays.md): An overlay is an additional map layer.',
      '- [Core](/docs/flutter/guides/core.md): Create landmarks, markers and an overlay item.',
    ]);
    expect(searchIndex(pages, 'create overlay', 2).map((h) => h.title)).toEqual(['Overlays', 'Core']);
  });

  it('weighs a word found only in a parenthetical aside of a description less', () => {
    const pages = flutter([
      '- [Alarms & voting](/docs/flutter/guides/alarms-voting.md): Two panels for driving alarms (safety cameras, sections).',
      '- [Fly To Area](/docs/flutter/examples/fly-to-area.md): Fly the camera to an area.',
    ]);
    expect(searchIndex(pages, 'camera', 2).map((h) => h.title)).toEqual(['Fly To Area', 'Alarms & voting']);
  });

  it('reads "coordinates to addresses" in a description as reverse geocoding', () => {
    const pages = flutter([
      '- [Search & Geocoding](/docs/flutter/guides/geocoding.md): Convert coordinates to human-readable addresses.',
      '- [Search](/docs/flutter/guides/search.md): Text search for places.',
    ]);
    const [hit] = searchIndex(pages, 'reverse geocoding', 2);
    expect(hit).toMatchObject({ title: 'Search & Geocoding', matched: 2, coversRarestWord: true });
  });

  it('on a tie, ranks first the page whose description names the query earliest', () => {
    const pages = flutter([
      '- [Styling](/docs/flutter/guides/styling.md): Customize the map with styles created in Magic Lane Studio.',
      '- [Weather](/docs/flutter/guides/weather.md): The Magic Lane weather service and its forecasts.',
      '- [Other](/docs/flutter/guides/other.md): Nothing about it.',
    ]);
    expect(searchIndex(pages, 'magic lane', 3).map((h) => h.title)).toEqual(['Weather', 'Styling']);
    // The sentence counts before the word: a description that names the query in its first sentence, late,
    // comes before one that names it early in its second.
    const sentences = flutter([
      '- [Alarms](/docs/flutter/guides/alarms.md): Warnings on the road. Magic Lane alarms cover speed and areas.',
      '- [Offline](/docs/flutter/guides/offline.md): Download maps for use without a network from Magic Lane.',
    ]);
    expect(searchIndex(sentences, 'magic lane', 2).map((h) => h.title)).toEqual(['Offline', 'Alarms']);
  });

  it("on a tie, puts the topic's own section entry first, then the shorter of the titles naming it", () => {
    const of = (id: string, lines: string[]): ReturnType<typeof parseLlmsTxt> =>
      parseLlmsTxt(
        lines.join('\n'),
        DOCS.sources.find((s) => s.id === id)!
      );
    // Both titles name traffic in their first sentence: the Compose package no longer wins on naming it first.
    const android = of('android', [
      '- [Traffic & roadblocks](/docs/android/guides/compose/traffic-and-roadblocks.md): The traffic package provides the composables for building a persistent-roadblock tool: a card that presents one roadblock, and the toolbar used while drawing one.',
      '- [Traffic Events](/docs/android/guides/core/traffic-events.md): The Maps SDK for Android provides real-time information about traffic events, such as delays, which can occur in various forms.',
      '- [Integrate the SDK](/docs/android/guides/get-started/integrate-sdk.md): This guide describes the steps to install the most recent version of the Maps SDK for Android and configure your Android app to use the SDK.',
      '- [Get started with Compose](/docs/android/guides/compose/get-started.md): This guide shows how to add the Jetpack Compose support to your project and host an interactive map with the GemMap composable.',
    ]);
    expect(searchIndex(android, 'traffic', 2).map((h) => h.title)).toEqual(['Traffic Events', 'Traffic & roadblocks']);
    // A common word in the title ("map", on 40% or more of the pages) names no topic: for "tilt the map" both
    // titles have "map" alone, both descriptions say "tilt", and the one naming the query earlier comes first —
    // not the shorter title.
    const maps = of('android', [
      '- [Hello Map](/docs/android/examples/maps-3dscene/hello-map.md): In this example you will learn how to render an interactive map centered on a desired location. The map is fully 3D, supporting pan, pinch-zoom, rotate and tilt.',
      '- [Map Gestures](/docs/android/examples/maps-3dscene/map-gestures.md): This example demonstrates how to handle map gestures. The map supports pan, zoom, rotate and tilt, and every gesture the user performs is reported through a dedicated callback.',
      '- [Map Compass](/docs/android/examples/maps-3dscene/map-compass.md): This example demonstrates how to render a compass icon that reflects the heading of the map.',
      '- [Overlapped Maps](/docs/android/examples/maps-3dscene/overlapped-maps.md): This example demonstrates how to layer map views.',
      '- [Get started with Compose](/docs/android/guides/compose/get-started.md): This guide shows how to host an interactive map with the GemMap composable.',
      '- [Traffic Events](/docs/android/guides/core/traffic-events.md): Real-time information about traffic events.',
      '- [Integrate the SDK](/docs/android/guides/get-started/integrate-sdk.md): Install the most recent version of the SDK.',
      '- [Routing](/docs/android/guides/routing.md): Calculating, customizing and analyzing routes.',
    ]);
    expect(searchIndex(maps, 'tilt the map', 2).map((h) => h.title)).toEqual(['Map Gestures', 'Hello Map']);
    // With no other word in the query, a common one in the title does name it: the shorter title first.
    expect(searchIndex(maps, 'map', 2).map((h) => h.title)).toEqual(['Hello Map', 'Map Compass']);
    // The section's "Get started" comes before its other guides; the introduction of the React Native plugin
    // (introduction.md) before its examples; the fleet-management Overview before Customers.
    const ios = of('ios', [
      '- [Positioning & Sensors](/docs/ios/guides/positioning.md): This section covers positioning workflows in the Maps SDK for iOS.',
      '- [Custom positioning](/docs/ios/guides/positioning/custom-positioning.md): Learn how to push custom positions into an external DataSourceContext and consume them through PositionContext.',
      '- [Get started with positioning](/docs/ios/guides/positioning/get-started-positioning.md): Learn how to configure permissions and start receiving live position updates in iOS.',
    ]);
    expect(searchIndex(ios, 'positioning', 2).map((h) => h.title)).toEqual([
      'Get started with positioning',
      'Custom positioning',
    ]);
    const typescript = of('typescript', [
      '- [React Native](/docs/typescript/integrations/react-native.md): The plugin for React Native.',
      '- [Create a React Native app](/docs/typescript/integrations/react-native/create-a-react-native-app.md): This guide walks you through creating a React Native project and running it on Android or iOS.',
      '- [React Native Examples](/docs/typescript/integrations/react-native/examples.md): React Native is a popular framework for building mobile applications using JavaScript and React.',
      '- [React Native plugin](/docs/typescript/integrations/react-native/introduction.md): Built on top of the Magic Lane TypeScript SDK, the React Native plugin extends its core mapping capabilities with a native component for map rendering.',
    ]);
    expect(
      searchIndex(typescript, 'react native', 4)
        .map((h) => h.title)
        .slice(1, 3)
    ).toEqual(['React Native plugin', 'React Native Examples']);
    const cpp = of('cpp', [
      '- [Fleet management](/docs/cpp/guides/fleet-management.md): The Fleet Management SDK.',
      '- [Customers](/docs/cpp/guides/fleet-management/customer.md): The Customer class is a core component of the Fleet Management SDK, allowing users to create, manage, and retrieve customer data. Customers represent entities that place orders and serve as primary points for delivery or pickup. Each customer has a unique identity and a defined location, ensuring accurate routing and logistics optimization.',
      '- [Overview](/docs/cpp/guides/fleet-management/introduction/overview.md): Built into the Maps SDK for C++, the Fleet Management SDK provides a high-performance VRP optimization engine that models customers, orders, vehicles and territories, to automatically generate cost- and time-efficient fleet and delivery routes.',
    ]);
    const fleet = searchIndex(cpp, 'route optimization for a delivery fleet', 2);
    expect(fleet.map((h) => h.title)).toEqual(['Overview', 'Customers']);
    expect(fleet[0]!.score).toBe(fleet[1]!.score);
    // A query no title names: the introduction whose description opens with it ("Magic Lane": each SDK's
    // "Get started") before a page whose description opens with it too, though its title is shorter.
    const product = of('android', [
      "- [Weather](/docs/android/guides/weather.md): The Magic Lane Android SDK's WeatherService class gives forecasts.",
      '- [Get started](/docs/android/guides/get-started.md): The Magic Lane SDKs enable developers to build apps.',
    ]);
    const named = searchIndex(product, 'Magic Lane', 2);
    expect(named.map((h) => h.title)).toEqual(['Get started', 'Weather']);
    expect(named[0]!.score).toBe(named[1]!.score);
    // Only the entry of the topic's own section: "Get started with Compose" says nothing of adding the SDK.
    expect(searchIndex(android, 'add project', 2).map((h) => h.title)).toEqual([
      'Integrate the SDK',
      'Get started with Compose',
    ]);
  });

  it("boosts the preferred platform's pages only where the title names the topic", () => {
    const cloud = parseLlmsTxt(
      '- [Isochrones API](/docs/cloud-rest-api/isochrones.md): Areas reachable within a time, area by area.',
      DOCS.sources.find((s) => s.id === 'cloud-rest-api')!
    );
    const ios = parseLlmsTxt(
      '- [Areas alarms](/docs/ios/areas-alarms.md): Alarms for an area.',
      DOCS.sources.find((s) => s.id === 'ios')!
    );
    const hits = searchIndex([...cloud, ...ios], 'rest area', 2, { prefer: platformPreference('rest area') });
    expect(hits.map((h) => h.title)).toEqual(['Areas alarms', 'Isochrones API']);
    expect(topicInTitle(new Set(['area']), ['rest', 'area'], new Set(['rest']))).toBe(true);
    expect(topicInTitle(new Set(['rest']), ['rest', 'area'], new Set(['rest']))).toBe(false);
  });

  it('rewards query words that stay adjacent, compared as stems', () => {
    const pages = flutter([
      '- [Route to Calculate](/docs/flutter/a.md): x',
      '- [Calculate Route Example](/docs/flutter/b.md): x',
    ]);
    expect(searchIndex(pages, 'calculating routes', 1)[0]!.title).toBe('Calculate Route Example');
  });

  it('gives an example no description phrase or pair bonus when a guide covers the whole query', () => {
    const of = (id: string, lines: string[]): ReturnType<typeof parseLlmsTxt> =>
      parseLlmsTxt(
        lines.join('\n'),
        DOCS.sources.find((s) => s.id === id)!
      );
    // Map Compass says "the map rotates" in passing; the guide lists rotation among what it covers.
    const compass = of('android', [
      '- [Map Compass](/docs/android/examples/maps-3dscene/map-compass.md): This example demonstrates how to render a compass icon that reflects the heading of the map. The compass updates as the map rotates.',
      '- [Map Gestures](/docs/android/examples/maps-3dscene/map-gestures.md): This example demonstrates how to handle map gestures. The map supports pan, zoom, rotate and tilt.',
    ]);
    const guide = of('flutter', [
      '- [Adjust the map view](/docs/flutter/guides/maps/adjust-map.md): The Maps SDK for Flutter provides multiple ways to modify the map view: center on coordinates, change the zoom, tilt and rotation.',
    ]);
    expect(searchIndex([...compass, ...guide], 'map rotation', 3).map((h) => h.title)).toEqual([
      'Adjust the map view',
      'Map Compass',
      'Map Gestures',
    ]);
    // With no guide covering the query, the phrase still tells the examples apart.
    const [first, second] = searchIndex(compass, 'map rotation', 2);
    expect([first!.title, second!.title]).toEqual(['Map Compass', 'Map Gestures']);
    expect(first!.score).toBeGreaterThan(second!.score);
    // A guide's own description phrase counts as ever.
    const guides = of('flutter', [
      '- [Interact with the map](/docs/flutter/guides/maps/interact.md): Gestures, selection and events on the map; zoom, tilt and rotation.',
      '- [Adjust the map view](/docs/flutter/guides/maps/adjust-map.md): Center the map, then set its zoom, tilt and map rotation.',
    ]);
    expect(searchIndex(guides, 'map rotation', 2).map((h) => h.title)).toEqual([
      'Adjust the map view',
      'Interact with the map',
    ]);
  });

  it('matches the query as a phrase word by word, whatever the punctuation', () => {
    const pages = flutter([
      '- [Turns](/docs/flutter/a.md): Turn icons for navigation.',
      '- [Navigation](/docs/flutter/b.md): Build turn-by-turn navigation into your app.',
    ]);
    expect(searchIndex(pages, 'turn by turn navigation', 1)[0]!.title).toBe('Navigation');
  });

  it('breaks ties toward the developer guides, then guides over examples', () => {
    const tie = [
      ...parseLlmsTxt('- [Keys](/docs/flutter/examples/keys.md): API key.\n', FLUTTER_SOURCE),
      ...parseLlmsTxt('- [Keys](/docs/flutter/guides/keys.md): API key.\n', FLUTTER_SOURCE),
      ...parseLlmsTxt('- [Keys](/docs/guides/keys.md): API key.\n', DEVELOPER_SOURCE),
    ];
    expect(searchIndex(tie, 'api key', 3).map((h) => h.path)).toEqual([
      '/docs/guides/keys.md',
      '/docs/flutter/guides/keys.md',
      '/docs/flutter/examples/keys.md',
    ]);
  });

  const entries = parseLlmsTxt(FLUTTER_LLMS, FLUTTER_SOURCE);

  it('ranks an exact title above a title that merely contains the query', () => {
    const hits = searchIndex(entries, 'calculate route', 5);
    expect(hits[0]!.title).toBe('Calculate Route');
    expect(hits[1]!.title).toBe('Calculate Bike Route');
  });

  it('matches whole words only: "id" does not match "guide"', () => {
    expect(searchIndex(entries, 'id', 5)).toEqual([]);
    expect(searchIndex(entries, 'route', 5).length).toBeGreaterThan(0);
  });

  it('ignores stopwords, but not the product name', () => {
    expect(searchIndex(entries, 'docs on the', 5)).toEqual([]);
    const developer = parseLlmsTxt(
      DEVELOPER_LLMS + '- [Magic Lane MCP Server](/docs/guides/mcp-server.md)\n',
      DEVELOPER_SOURCE
    );
    expect(searchIndex(developer, 'what is Magic Lane', 5)[0]!.title).toBe('Magic Lane MCP Server');
  });

  it('prefers the page that covers the whole query over a title match on one common word', () => {
    const corpus = parseLlmsTxt(
      '- [Routing API](/docs/flutter/a/routing-api.md): Compute routes.\n' +
        '- [Search API](/docs/flutter/a/search-api.md): Find places.\n' +
        '- [Vector Tiles API](/docs/flutter/a/tiles-api.md): Map tiles.\n' +
        '- [Get Started](/docs/flutter/get-started.md): Create an account and get your API key.\n',
      FLUTTER_SOURCE
    );
    const [first] = searchIndex(corpus, 'API key', 5);
    expect(first!.title).toBe('Get Started');
    expect(first!.coverage).toBe(1);
    expect(searchIndex(corpus, 'API key', 5)[1]!.coverage).toBeLessThan(0.5);
  });

  it('counts action words like "add" for half, and never as the most specific word', () => {
    const corpus = parseLlmsTxt(
      '- [Add Orders](/docs/flutter/a/add-orders.md): Add orders to a route.\n' +
        '- [Markers](/docs/flutter/a/markers.md): Markers on the map.\n' +
        '- [Marker Clustering](/docs/flutter/a/clustering.md): Group many markers.\n' +
        '- [Display Markers](/docs/flutter/a/display.md): Show markers.\n',
      FLUTTER_SOURCE
    );
    const hits = searchIndex(corpus, 'add markers', 5);
    expect(hits[0]!.title).toBe('Markers');
    // A page that matches only the action word matches nothing of the topic: it is no hit at all.
    expect(hits.map((h) => h.title)).not.toContain('Add Orders');
    // A query of action words only still has a most specific word.
    expect(searchIndex(corpus, 'add', 5)[0]!.coversRarestWord).toBe(true);
    // The words that carry the topic: all but the action words ("upgrade" is one), unless nothing else is left.
    expect(topicTokens('add markers')).toEqual(['marker']);
    expect(topicTokens('upgrade to 3.1.4')).toEqual(['3.1.4']);
    expect(topicTokens('add')).toEqual(['add']);
  });

  it('scores a platform word left in a query (part of a feature name) like any word', () => {
    const java = parseLlmsTxt(
      '- [Route Simulation](/docs/android/examples/route-simulation.md): Simulate a route.\n' +
        '- [Route Simulation Java](/docs/android/examples/route-simulation-java.md): Simulate a route.\n',
      FLUTTER_SOURCE
    );
    expect(searchIndex(java, 'java route simulation', 1)[0]!.title).toBe('Route Simulation Java');
    // Only platform words: they are ordinary words then (nothing here mentions them).
    expect(searchIndex(java, 'flutter', 3)).toEqual([]);
  });

  it('puts the title that is the query in its own words first, and an overview before an example', () => {
    const pages = parseLlmsTxt(
      '- [Routes](/docs/flutter/guides/core/routes.md): Route objects.\n' +
        '- [Routing](/docs/flutter/examples/routing-navigation/routing.md): Compute a route.\n' +
        '- [Routing](/docs/flutter/guides/routing.md): Calculate routes.\n' +
        '- [Route Bookmarks](/docs/flutter/guides/routing/route-bookmarks.md): Save routes.\n',
      FLUTTER_SOURCE
    );
    expect(searchIndex(pages, 'routing', 3).map((h) => h.path)).toEqual([
      '/docs/flutter/guides/routing.md',
      '/docs/flutter/examples/routing-navigation/routing.md',
      '/docs/flutter/guides/routing/route-bookmarks.md',
    ]);
    // The same stems in another form are not the query's title, but for a
    // plural: "Positions" is not the page for "positioning", "Routes" is for "route".
    const forms = parseLlmsTxt(
      '- [Positions](/docs/flutter/guides/core/positions.md): Position objects.\n' +
        '- [Get started with positioning](/docs/flutter/guides/positioning/get-started.md): Positioning.\n' +
        '- [Routes](/docs/flutter/guides/core/routes.md): Route objects.\n' +
        '- [Calculate Route](/docs/flutter/examples/calculate-route.md): Compute a route.\n',
      FLUTTER_SOURCE
    );
    expect(searchIndex(forms, 'positioning', 1)[0]!.title).toBe('Get started with positioning');
    expect(searchIndex(forms, 'route', 1)[0]!.title).toBe('Routes');
    // Each SDK's setup page is asked for by install, installation and setup.
    const setup = parseLlmsTxt(
      '- [Integrate the SDK](/docs/flutter/guides/get-started/integrate-sdk.md): Step 1: Add the package.\n' +
        '- [SDK Automatic Activation](/docs/flutter/guides/activation.md): Activate the SDK to install a key.\n',
      FLUTTER_SOURCE
    );
    for (const query of ['install', 'installation', 'setup'])
      expect(searchIndex(setup, query, 1)[0]!.title, query).toBe('Integrate the SDK');
    // "SDK" next to the platform word names the platform, never a feature: "Maps SDK for Flutter" does not keep "flutter".
    expect(platformScope('integrate the sdk flutter', ['Maps SDK for Flutter', 'Integrate the SDK'])).toEqual({
      topic: 'integrate',
      sources: ['flutter'],
    });
    // A developer guide is an overview too: "Get Started" for every SDK.
    const started = [
      ...parseLlmsTxt('- [Get started](/docs/flutter/guides/maps/get-started.md): Maps.\n', FLUTTER_SOURCE),
      ...parseLlmsTxt('- [Get Started](/docs/guides/get-started.md): Your account.\n', DEVELOPER_SOURCE),
    ];
    expect(searchIndex(started, 'get started', 1)[0]!.source).toBe('developer');
  });

  it('matches the setup aliases of "Integrate the SDK" only for a query about setting up and nothing else', () => {
    const pages = flutter([
      '- [Integrate the SDK](/docs/flutter/guides/get-started/integrate-sdk.md): Step 1: Add the package.',
      '- [Add voice guidance](/docs/flutter/guides/navigation/voice-guidance.md): Spoken instructions while navigating.',
      '- [Offline maps](/docs/flutter/guides/offline.md): Download maps for offline use.',
    ]);
    // "npm" heads no page: the query is still about installing and nothing else documented.
    for (const query of ['set up', 'how do I set up the sdk', 'sdk setup', 'install', 'npm install']) {
      expect(searchIndex(pages, query, 1)[0]!.title, query).toBe('Integrate the SDK');
    }
    // With a topic of its own, the setup words are no title words: "up" and
    // "install" are not the most specific word, the topic's own words are.
    const [voice] = searchIndex(pages, 'set up voice guidance', 3);
    expect(voice).toMatchObject({ title: 'Add voice guidance', coversRarestWord: true, rarestInHeading: true });
    expect(searchIndex(pages, 'set up voice guidance', 3).map((h) => h.title)).not.toContain('Integrate the SDK');
    expect(searchIndex(pages, 'install offline maps', 1)[0]!.title).toBe('Offline maps');
  });

  it('measures word rarity on a wider corpus when asked', () => {
    const one = parseLlmsTxt('- [Route Alarms](/docs/flutter/a/alarms.md): Alarms on a route.\n', FLUTTER_SOURCE);
    const wide = [...one, ...entries];
    // Alone, both words are equally rare; across all pages "route" is common.
    const [hit] = searchIndex(one, 'route alarms', 1, { corpus: wide });
    expect(hit!.coversRarestWord).toBe(true);
    const [partial] = searchIndex(entries, 'route alarms', 1, { corpus: wide });
    expect(partial!.coversRarestWord).toBe(false);
  });

  it('matches descriptions and sections', () => {
    const hits = searchIndex(entries, 'waypoints', 5);
    expect(hits.map((h) => h.title)).toEqual(['Routes']);
    expect(searchIndex(entries, 'navigation', 10).some((h) => h.title === 'Draw Route')).toBe(true);
  });

  it('folds plurals in both directions', () => {
    expect(searchIndex(entries, 'markers', 5)[0]!.title).toBe('Add Markers');
    expect(searchIndex(entries, 'marker', 5)[0]!.title).toBe('Add Markers');
  });

  it('gives a phrase bonus in title and description', () => {
    expect(searchIndex(entries, 'bike route', 5)[0]!.title).toBe('Calculate Bike Route');
    expect(searchIndex(entries, 'navigable path', 5)[0]!.title).toBe('Routes');
  });

  it('skips the phrase bonus for queries of three characters or fewer', () => {
    expect(searchIndex(entries, 'map', 5).map((h) => h.title)).toContain('Add Markers');
  });

  it('reports matched and query word counts, and whether the rarest word matched', () => {
    const [hit] = searchIndex(entries, 'draw route nowhere', 1);
    expect(hit!.matched).toBe(2);
    expect(hit!.queryWords).toBe(3);
    // "nowhere" is the rarest word but in no title or section: it says how the question is put, not
    // what about, so the most specific word is "draw", which matched.
    expect(hit!.coversRarestWord).toBe(true);
    expect(searchIndex(entries, 'draw route bike', 5).find((h) => h.title === 'Routes')!.coversRarestWord).toBe(false);
    expect(searchIndex(entries, 'bike route', 1)[0]!.coversRarestWord).toBe(true);
    expect(searchIndex(entries, 'map route', 5).find((h) => h.title === 'Routes')!.coversRarestWord).toBe(false);
  });

  it('returns nothing for unrelated or empty queries', () => {
    expect(searchIndex(entries, 'quaternion', 5)).toEqual([]);
    expect(searchIndex(entries, '   ', 5)).toEqual([]);
  });

  it('respects the limit and ranks the exact (stemmed) title first', () => {
    expect(searchIndex(entries, 'route', 2)).toHaveLength(2);
    expect(searchIndex(entries, 'route', 10)[0]!.title).toBe('Routes');
  });

  it('breaks exact ties toward the shorter description', () => {
    const tied = parseLlmsTxt(
      '- [Get started](/docs/flutter/a.md): Long text about many things and an API key too.\n' +
        '- [Get started](/docs/flutter/b.md): Get your API key.\n',
      FLUTTER_SOURCE
    );
    expect(searchIndex(tied, 'API key', 5).map((h) => h.path)).toEqual(['/docs/flutter/b.md', '/docs/flutter/a.md']);
  });

  it("orders tied titles the same whatever the input order: a family's shorter title first, else by position", () => {
    const pages = flutter([
      '- [Route Navigation](/docs/flutter/examples/route-navigation.md): Navigate a route to a destination with the SDK.',
      '- [Android Auto Navigation](/docs/flutter/examples/auto-navigation.md): Navigate a route to a destination in the car.',
      '- [Navigate Route](/docs/flutter/examples/navigate-route.md): This example shows how to navigate a route to a destination.',
    ]);
    const titles = (entries: typeof pages): string[] =>
      searchIndex(entries, 'navigate to a destination', 5).map((h) => h.title);
    // All three tie. "Navigate Route" and "Route Navigation" are one family (the shorter first); "Android Auto
    // Navigation" is not, and names the topic as early as "Route Navigation": compared pairwise, the three
    // preferences would form a cycle, and the order would depend on the input.
    expect(titles(pages)).toEqual(['Navigate Route', 'Route Navigation', 'Android Auto Navigation']);
    expect(titles([...pages].reverse())).toEqual(titles(pages));
    expect(titles([pages[1]!, pages[2]!, pages[0]!])).toEqual(titles(pages));
    // A one-word title is of one family with every title holding its word: it moves up before all of them.
    const plain = flutter([
      '- [Navigation](/docs/flutter/examples/navigation.md): An example that shows how to navigate a route to a destination.',
    ]);
    expect(titles([...pages, ...plain])).toEqual([
      'Navigation',
      'Navigate Route',
      'Route Navigation',
      'Android Auto Navigation',
    ]);
    // Titles that do not name the topic are ordered by where their descriptions name it — but a family's
    // shorter title still comes first, though the longer one names the topic in an earlier sentence.
    const described = flutter([
      '- [Hello Map Compose](/docs/flutter/examples/hello-map-compose.md): Tilt and rotate the map in a Compose app.',
      '- [Hello Map](/docs/flutter/examples/hello-map.md): Render an interactive map. Pan, zoom, rotate and tilt it.',
      '- [Map Gestures](/docs/flutter/examples/map-gestures.md): Handle gestures. The map supports pan, zoom and tilt.',
    ]);
    const tilt = (entries: typeof described): string[] => searchIndex(entries, 'tilt', 5).map((h) => h.title);
    expect(tilt(described)).toEqual(['Hello Map', 'Hello Map Compose', 'Map Gestures']);
    expect(tilt([...described].reverse())).toEqual(tilt(described));
  });

  it('tokenizes a page once: a search over many tied pages lowercases no more text than one over a single page', () => {
    const page = (i: number): string => `- [Tied Page ${i}](/docs/flutter/tied-${i}.md): The same words about the map.`;
    const one = flutter([page(1)]);
    const many = flutter(Array.from({ length: 40 }, (_, i) => page(i + 10)));
    searchIndex(one, 'map', 50); // the pages are tokenized when first searched
    searchIndex(many, 'map', 50);
    const lowered = vi.spyOn(String.prototype, 'toLowerCase');
    searchIndex(one, 'map', 50);
    const forOne = lowered.mock.calls.length;
    lowered.mockClear();
    const hits = searchIndex(many, 'map', 50);
    const forMany = lowered.mock.calls.length;
    lowered.mockRestore();
    expect(hits).toHaveLength(40);
    // The tie-break compares the pages' title words: looked up, not tokenized again.
    expect(forMany).toBe(forOne);
  });

  it('breaks exact ties toward the shorter title, then alphabetically, then by path', () => {
    const tied = parseLlmsTxt(
      '- [Zed Thing](/docs/flutter/a/zed-thing.md)\n- [Abc Thing](/docs/flutter/b/abc-thing.md)\n' +
        '- [Thing](/docs/flutter/z/thing.md)\n- [Thing](/docs/flutter/a/thing.md)\n',
      FLUTTER_SOURCE
    );
    expect(searchIndex(tied, 'thing', 10).map((h) => h.path)).toEqual([
      '/docs/flutter/a/thing.md',
      '/docs/flutter/z/thing.md',
      '/docs/flutter/b/abc-thing.md',
      '/docs/flutter/a/zed-thing.md',
    ]);
  });

  it('scores only the path below the source root', () => {
    const outside = parseLlmsTxt('- [Odd](https://developer.magiclane.com/other/flutter-thing.md)\n', FLUTTER_SOURCE);
    expect(searchIndex(outside, 'flutter', 5)[0]!.title).toBe('Odd');
    expect(searchIndex(entries, 'flutter', 5)).toEqual([]);
  });
});

describe('searchIndex with a platform preference', () => {
  const entries = [
    ...parseLlmsTxt(
      '- [Cloud REST APIs](/docs/cloud-rest-api/guides/overview.md): Routing, geocoding and search over HTTP.\n' +
        '- [Reverse Geocode API](/docs/cloud-rest-api/guides/reverse-geocode.md): Addresses from coordinates.\n',
      DOCS.sources.find((s) => s.id === 'cloud-rest-api') as DocSource
    ),
    ...parseLlmsTxt(
      '- [Search & Geocoding](/docs/android/guides/search/geocoding.md): Geocoding on Android.\n',
      DOCS.sources.find((s) => s.id === 'android') as DocSource
    ),
  ];

  it('ranks the preferred platform higher and the preference word low, without leaving others out', () => {
    const plain = searchIndex(entries, 'cloud geocoding', 10).map((h) => h.title);
    expect(plain[0]).toBe('Cloud REST APIs');
    const prefer = platformPreference('cloud geocoding');
    const ranked = searchIndex(entries, 'cloud geocoding', 10, { prefer }).map((h) => h.title);
    expect(ranked).toEqual(['Reverse Geocode API', 'Search & Geocoding', 'Cloud REST APIs']);
  });

  it("matches the preferred platform's title without the preference word, and only that platform's", () => {
    const titled = [
      ...parseLlmsTxt(
        '- [Optimization](/docs/android/guides/optimization.md): Battery tips.\n',
        DOCS.sources.find((s) => s.id === 'android') as DocSource
      ),
      ...parseLlmsTxt(
        '- [Update Optimization](/docs/cloud-rest-api/guides/update-optimization.md): Change one.\n' +
          '- [Optimization](/docs/cloud-rest-api/guides/optimization.md): Plan routes for a fleet.\n',
        DOCS.sources.find((s) => s.id === 'cloud-rest-api') as DocSource
      ),
    ];
    const prefer = platformPreference('cloud optimization');
    const ranked = searchIndex(titled, 'cloud optimization', 10, { prefer }).map((h) => `${h.title} ${h.source}`);
    expect(ranked[0]).toBe('Optimization cloud-rest-api');
    expect(ranked.indexOf('Optimization android')).toBeGreaterThan(
      ranked.indexOf('Update Optimization cloud-rest-api')
    );
    // The same stems in other words ("Route" for "routing") count less than the very words.
    const cloud = DOCS.sources.find((s) => s.id === 'cloud-rest-api') as DocSource;
    const routes = parseLlmsTxt(
      '- [Routing](/docs/cloud-rest-api/guides/routing.md): x.\n- [Route](/docs/cloud-rest-api/guides/route.md): x.\n',
      cloud
    );
    const byTitle = searchIndex(routes, 'cloud routing', 10, { prefer: platformPreference('cloud routing') });
    expect(byTitle.map((h) => h.title)).toEqual(['Routing', 'Route']);
    expect(byTitle[0]!.score).toBeGreaterThan(byTitle[1]!.score);
  });
});

describe('toAbsoluteUrl', () => {
  it('passes through absolute URLs', () => {
    expect(toAbsoluteUrl('https://developer.magiclane.com/docs/x.md')).toBe(
      'https://developer.magiclane.com/docs/x.md'
    );
  });

  it('anchors both slash-prefixed and bare paths', () => {
    expect(toAbsoluteUrl('/docs/x.md')).toBe('https://developer.magiclane.com/docs/x.md');
    expect(toAbsoluteUrl('docs/x.md')).toBe('https://developer.magiclane.com/docs/x.md');
  });
});

describe('selectSources', () => {
  it('returns every source for no filter or an empty filter, and only known ids otherwise', () => {
    expect(selectSources()).toHaveLength(DOCS.sources.length);
    expect(selectSources([])).toHaveLength(DOCS.sources.length);
    expect(selectSources(['flutter', 'nope']).map((s) => s.id)).toEqual(['flutter']);
  });
});

describe('loadIndex', () => {
  let restore = (): void => {};

  beforeEach(() => {
    seedFixtures();
  });

  afterEach(() => {
    restore();
    restore = () => {};
    vi.useRealTimers();
  });

  it('loads and merges all sources by default, reporting no failures', async () => {
    const { entries, failed } = await loadIndex();
    expect(new Set(entries.map((e) => e.source))).toEqual(new Set(DOCS.sources.map((s) => s.id)));
    expect(failed).toEqual([]);
  });

  it('filters to the requested sources', async () => {
    const { entries } = await loadIndex([FLUTTER_SOURCE.id]);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.source === FLUTTER_SOURCE.id)).toBe(true);
  });

  it('returns nothing for unknown source ids', async () => {
    await expect(loadIndex(['does-not-exist'])).resolves.toEqual({ entries: [], failed: [] });
  });

  it('names the sources that failed instead of dropping them silently', async () => {
    resetCaches();
    seedIndex(FLUTTER_SOURCE.id, FLUTTER_LLMS);
    ({ restore } = stubFetch({})); // every other index answers 404
    const { entries, failed } = await loadIndex();
    expect(entries.every((e) => e.source === FLUTTER_SOURCE.id)).toBe(true);
    expect(failed.map((f) => f.source).sort()).toEqual(
      DOCS.sources
        .map((s) => s.id)
        .filter((id) => id !== FLUTTER_SOURCE.id)
        .sort()
    );
    expect(failed[0]!.reason).toContain('HTTP 404');
  });

  it('fetches an index through the shared pipeline and memoizes it', async () => {
    resetCaches();
    const stub = stubFetch({ [DEVELOPER_SOURCE.indexUrl]: DEVELOPER_LLMS });
    restore = stub.restore;
    const first = await loadIndex([DEVELOPER_SOURCE.id]);
    const second = await loadIndex([DEVELOPER_SOURCE.id]);
    expect(first.entries.map((e) => e.title)).toEqual(['Get Started', 'Map Studio', 'Create a Map Style']);
    expect(second.entries).toEqual(first.entries);
    expect(stub.calls).toEqual([DEVELOPER_SOURCE.indexUrl]);
  });

  it('shares one download between concurrent loads of the same source', async () => {
    resetCaches();
    const stub = stubFetch({ [DEVELOPER_SOURCE.indexUrl]: DEVELOPER_LLMS });
    restore = stub.restore;
    await Promise.all([loadIndex([DEVELOPER_SOURCE.id]), loadIndex([DEVELOPER_SOURCE.id])]);
    expect(stub.calls).toHaveLength(1);
  });

  it('serves the previous index when a refresh fails after the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    resetCaches();
    const stub = stubFetch({ [DEVELOPER_SOURCE.indexUrl]: DEVELOPER_LLMS });
    const first = await loadIndex([DEVELOPER_SOURCE.id]);
    stub.restore();
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    ({ restore } = stubFetch({ [DEVELOPER_SOURCE.indexUrl]: 404 }));
    const again = await loadIndex([DEVELOPER_SOURCE.id]);
    expect(again.failed).toEqual([]);
    expect(again.entries).toEqual(first.entries);
  });

  it('renews the memo with a 304 and re-parses on fresh content', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    resetCaches();
    let stage = 0;
    ({ restore } = stubFetch({
      [DEVELOPER_SOURCE.indexUrl]: () => {
        stage++;
        if (stage === 1) return new Response(DEVELOPER_LLMS, { status: 200, headers: { etag: '"v1"' } });
        if (stage === 2) return new Response(null, { status: 304 });
        return new Response('- [Only](/docs/guides/only.md)\n', { status: 200 });
      },
    }));
    const first = await loadIndex([DEVELOPER_SOURCE.id]);
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    const second = await loadIndex([DEVELOPER_SOURCE.id]);
    expect(second.entries).toEqual(first.entries);
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    const third = await loadIndex([DEVELOPER_SOURCE.id]);
    expect(third.entries.map((e) => e.title)).toEqual(['Only']);
    expect(stage).toBe(3);
  });
});
