/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared test helpers: an in-memory MCP client/server pair and fixture
 * documents seeded into the memos and the page cache so no test touches the
 * network. The fixtures have the SAME SHAPE as the published files: an index
 * with only "# Title" and "## Docs" (sections come from the URLs), and a
 * full-text export whose pages are separated by `---` lines in index order.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { DOCS } from '../src/config/constants.js';
import { clearHttpCache, seedHttpCache } from '../src/utils/http-client.js';
import { clearIndexCache, seedIndex } from '../src/docs/docs-index.js';
import { clearFullTextCache, seedFullTextSections } from '../src/docs/full-text.js';

export const DEVELOPER_SOURCE = DOCS.sources[0]!;
export const FLUTTER_SOURCE = DOCS.sources[1]!;
/** The platform SDK sources after flutter (android, ios, cpp, typescript, cloud-rest-api). */
export const SDK_SOURCES = DOCS.sources.slice(2);

export const BASE = 'https://developer.magiclane.com';

export const DEVELOPER_LLMS = `# Magic Lane Documentation

## Docs

- [Get Started](/docs/guides/get-started.md): In this guide you will learn how to create your free Magic Lane account and get your API Key.
- [Map Studio](/docs/guides/map-studio.md): Create beautiful, on-brand maps with Magic Lane Map Studio.
- [Create a Map Style](/docs/guides/map-studio/create-a-map-style.md): Create a custom map style in Map Studio.
`;

export const GET_STARTED_BODY = 'Create your free Magic Lane account and your first project to get an API Key.';

export const DEVELOPER_FULL = `# Magic Lane Documentation

## Docs

### Get Started

Last updated:

<!-- -->

August 12, 2026

${GET_STARTED_BODY}

---

### Map Studio

Last updated: January 5, 2026

Map Studio is a web-based editor for map styles.

---

### Create a Map Style

Open Map Studio and click New Style.

---
`;

export const FLUTTER_LLMS = `# Magic Lane - Maps SDK for Flutter documentation

## Docs

- [Routing & Navigation](/docs/flutter/examples/routing-navigation.md): Routing and navigation examples.
- [Calculate Route](/docs/flutter/examples/routing-navigation/calculate-route.md): Calculate a route between two coordinates.
- [Calculate Bike Route](/docs/flutter/examples/routing-navigation/calculate-bike-route.md): Calculate a bike-specific route.
- [Draw Route](/docs/flutter/examples/routing-navigation/draw-route.md)
- [Maps & 3D Scene](/docs/flutter/examples/maps-3dscene.md): Map display examples.
- [Add Markers](/docs/flutter/examples/maps-3dscene/add-markers.md): Add markers to the map.
- [Routes](/docs/flutter/guides/core/routes.md): A route represents a navigable path between waypoints.
`;

/**
 * Full text in index order. "Calculate Route" contains a level-3 heading of
 * its own and a shell block with a `#` comment and a `### ` line, which must
 * not be taken for page boundaries or headings.
 */
export const FLUTTER_FULL = `# Magic Lane - Maps SDK for Flutter documentation

## Docs

### Routing & Navigation

Last updated: July 1, 2026

Routing and navigation examples for the Maps SDK for Flutter.

---

### Calculate Route

Last updated:

<!-- -->

August 20, 2026

Use RoutingService.calculateRoute to compute routes between waypoints.

#### Setup[\u200b](#setup "Direct link to Setup")

\`\`\`dart
final route = await RoutingService.calculateRoute(waypoints);
\`\`\`

### Advanced options

Set preferences on the RoutePreferences object.

\`\`\`bash
# install the sdk
flutter pub add gem_kit
### not a heading
\`\`\`

---

### Calculate Bike Route

Bike routes use the bike profile.

---

### Draw Route

Draw the computed route on the map with MapViewRoutesCollection.

---

### Maps & 3D Scene

Map display examples.

---

### Add Markers

Last updated: March 3, 2026

You can add markers to the map using MarkerCollection.

  \`\`\`dart
  final marker = Marker();
  \`\`\`

---

### Routes

A route represents a navigable path between waypoints.

---
`;

export const GET_STARTED_PAGE = `# Get Started\n\n${GET_STARTED_BODY}\n`;

/** Minimal per-SDK index fixture (android, ios, cpp, typescript, cloud-rest-api). */
export function sdkIndexFixture(id: string): string {
  return (
    `# Magic Lane - Maps SDK (${id})\n\n## Docs\n\n` +
    `- [Get Started (${id})](/docs/${id}/guides/get-started.md): Get started with the ${id} SDK.\n` +
    `- [Add Markers (${id})](/docs/${id}/examples/maps-3dscene/add-markers.md): Add markers on ${id}.\n`
  );
}

/** Minimal per-SDK llms-full.txt fixture, in the same order as the index. */
export function sdkFullTextFixture(id: string): string {
  return (
    `# Magic Lane - Maps SDK (${id})\n\n## Docs\n\n### Get Started (${id})\n\nOverview of the ${id} SDK.\n\n---\n\n` +
    `### Add Markers (${id})\n\nMarkers on ${id}.\n\n---\n`
  );
}

/** Reset every memo and cache and seed all documentation fixtures. */
export function seedFixtures(): void {
  resetCaches();
  seedIndex(DEVELOPER_SOURCE.id, DEVELOPER_LLMS);
  seedFullTextSections(DEVELOPER_SOURCE.id, DEVELOPER_FULL);
  seedIndex(FLUTTER_SOURCE.id, FLUTTER_LLMS);
  seedFullTextSections(FLUTTER_SOURCE.id, FLUTTER_FULL);
  for (const source of SDK_SOURCES) {
    seedIndex(source.id, sdkIndexFixture(source.id));
    seedFullTextSections(source.id, sdkFullTextFixture(source.id));
  }
  // The raw index is also an MCP resource, served from the page cache.
  seedHttpCache(DEVELOPER_SOURCE.indexUrl, DEVELOPER_LLMS);
  seedHttpCache(`${BASE}/docs/guides/get-started.md`, GET_STARTED_PAGE);
}

export function resetCaches(): void {
  clearHttpCache();
  clearIndexCache();
  clearFullTextCache();
}

/** Seed a page body under its canonical docs path. */
export function seedPage(path: string, body: string): void {
  seedHttpCache(`${BASE}${path}`, body);
}

export interface TestClient {
  client: Client;
  close: () => Promise<void>;
}

/** Spin up the real MCP server and a client over an in-memory transport. */
export async function connectClient(): Promise<TestClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Extract the first text block from a tools/call result. */
export function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content[0]?.text ?? '';
}

/** Whether a tools/call result is flagged as an error. */
export function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

/**
 * A fetch stub: `routes` maps URL → body (string), status (number), or a
 * Response factory. Unlisted URLs answer 404. Returns the call log.
 */
export function stubFetch(routes: Record<string, string | number | (() => Response | Promise<Response>)>): {
  calls: string[];
  restore: () => void;
} {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const route = routes[url];
    if (route === undefined) return new Response('not found', { status: 404, statusText: 'Not Found' });
    if (typeof route === 'number') return new Response('', { status: route, statusText: `Status ${route}` });
    if (typeof route === 'string')
      return new Response(route, { status: 200, headers: { 'content-type': 'text/plain' } });
    return route();
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}
