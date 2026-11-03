/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectClient, resetCaches, seedFixtures, stubFetch, textOf } from '../helpers.js';
import type { TestClient } from '../helpers.js';
import { seedHttpCache } from '../../src/utils/http-client.js';
import { seedIndex } from '../../src/docs/docs-index.js';
import { LIMITS } from '../../src/config/constants.js';

const MCP_INTRO =
  '# Magic Lane MCP Server\n\nBridge between AI intelligence and geospatial awareness. Setup and connection.';
const MCP_USAGE =
  '# Transform Your AI into a Geospatial Copilot\n\nGuidelines: prefer isochrones for reachability questions.';
const STUDIO_OVERVIEW = '# Map Studio\n\nCreate beautiful, on-brand maps with the intuitive web-based editor.';
const STUDIO_CREATE = '# Create a Map Style\n\nStart from a template and adjust colors, fonts, and layers.';
const STUDIO_CUSTOMIZE = '# Customize a Map Style\n\nRename your style and fine-tune individual layers.';
const STUDIO_DOWNLOAD = '# Download a Map Style\n\nSelect Download Style from the menu to save it to disk.';

function seedGuidePages(): void {
  seedHttpCache('https://developer.magiclane.com/docs/guides/mcp-server/introduction.md', MCP_INTRO);
  seedHttpCache('https://developer.magiclane.com/docs/guides/mcp-server/usage-guidelines.md', MCP_USAGE);
  seedHttpCache('https://developer.magiclane.com/docs/guides/map-studio.md', STUDIO_OVERVIEW);
  seedHttpCache('https://developer.magiclane.com/docs/guides/map-studio/create-a-map-style.md', STUDIO_CREATE);
  seedHttpCache('https://developer.magiclane.com/docs/guides/map-studio/customize-map-style.md', STUDIO_CUSTOMIZE);
  seedHttpCache('https://developer.magiclane.com/docs/guides/map-studio/download-style.md', STUDIO_DOWNLOAD);
}

describe('get_product_guide', () => {
  let t: TestClient;
  let unstub = (): void => {};

  beforeEach(async () => {
    seedFixtures();
    seedGuidePages();
    // A guide location that is not seeded answers 404, as on the site.
    ({ restore: unstub } = stubFetch({}));
    t = await connectClient();
  });

  afterEach(async () => {
    unstub();
    await t.close();
    vi.unstubAllGlobals();
  });

  it('defaults mcp-server to the usage guidelines', async () => {
    const result = await t.client.callTool({
      name: 'get_product_guide',
      arguments: { product: 'mcp-server' },
    });
    const text = textOf(result);
    expect(text).toContain('Usage Guidelines');
    expect(text).toContain('prefer isochrones for reachability questions');
    expect(text).not.toContain('Setup and connection');
  });

  it('defaults map-studio to the overview', async () => {
    const result = await t.client.callTool({
      name: 'get_product_guide',
      arguments: { product: 'map-studio' },
    });
    const text = textOf(result);
    expect(text).toContain('Magic Lane Studio — Overview');
    expect(text).toContain('web-based editor');
    expect(text).not.toContain('save it to disk');
  });

  it('returns a specific section on request', async () => {
    const result = await t.client.callTool({
      name: 'get_product_guide',
      arguments: { product: 'map-studio', section: 'download-style' },
    });
    const text = textOf(result);
    expect(text).toContain('Download a Map Style');
    expect(text).toContain('save it to disk');
  });

  it('concatenates every section in reading order for section=all', async () => {
    const result = await t.client.callTool({
      name: 'get_product_guide',
      arguments: { product: 'map-studio', section: 'all' },
    });
    const text = textOf(result);
    const positions = [
      text.indexOf('Magic Lane Studio — Overview'),
      text.indexOf('Create a Map Style'),
      text.indexOf('Customize a Map Style'),
      text.indexOf('Download a Map Style'),
    ];
    expect(positions[0]).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
    expect((result as { isError?: boolean }).isError).not.toBe(true);
  });

  it('serves the Magic Lane Studio pages from wherever the site publishes them', async () => {
    const NEW = 'https://developer.magiclane.com/docs/guides/map-studio/getting-started/download-and-use.md';
    seedHttpCache(NEW, '# Download and use in your app\n\nThe Download button saves a .style file.');
    // Not listed yet: the new location is tried first, the old one answers when it fails.
    const before = textOf(
      await t.client.callTool({ name: 'get_product_guide', arguments: { product: 'map-studio', section: 'all' } })
    );
    expect(before).toContain('The Download button saves a .style file.');
    expect(before).toContain('Rename your style'); // customize: only the old page is seeded
    expect(before).not.toContain('save it to disk');

    // Listed by the index: that location, without trying the others.
    seedIndex(
      'developer',
      '- [Create a style](/docs/guides/map-studio/getting-started/create-a-style.md): From a template.\n' +
        '- [Customize a Map Style](/docs/guides/map-studio/customize-map-style.md): Rename your style.\n'
    );
    seedHttpCache(
      'https://developer.magiclane.com/docs/guides/map-studio/getting-started/create-a-style.md',
      '# Create a style\n\nYou make a style in the portal.'
    );
    const listed = textOf(
      await t.client.callTool({
        name: 'get_product_guide',
        arguments: { product: 'map-studio', section: 'create-a-map-style' },
      })
    );
    expect(listed).toContain('You make a style in the portal.');
    expect(listed).toContain(
      'Source: https://developer.magiclane.com/docs/guides/map-studio/getting-started/create-a-style'
    );
  });

  it('fetches the pages alongside the index on a cold start, not after it', async () => {
    resetCaches();
    const CREATE_NEW = 'https://developer.magiclane.com/docs/guides/map-studio/getting-started/create-a-style.md';
    const { calls, restore } = stubFetch({
      'https://developer.magiclane.com/docs/llms.txt':
        '# Docs\n\n- [Create a style](/docs/guides/map-studio/getting-started/create-a-style.md): From a template.\n',
      [CREATE_NEW]: '# Create a style\n\nYou make a style in the portal.',
    });
    try {
      const cold = textOf(
        await t.client.callTool({
          name: 'get_product_guide',
          arguments: { product: 'map-studio', section: 'create-a-map-style' },
        })
      );
      expect(cold).toContain('You make a style in the portal.');
      // The index load starts, and the page is fetched without waiting for it
      // (its first location answers).
      expect(calls).toEqual(['https://developer.magiclane.com/docs/llms.txt', CREATE_NEW]);

      // With the index in memory, the page is served from it at once.
      calls.length = 0;
      const warm = textOf(
        await t.client.callTool({
          name: 'get_product_guide',
          arguments: { product: 'map-studio', section: 'create-a-map-style' },
        })
      );
      expect(warm).toContain('You make a style in the portal.');
      expect(calls).toEqual([]);
    } finally {
      restore();
    }
  });

  it('tries every location when the one the index in memory lists has moved away', async () => {
    resetCaches();
    const OLD = 'https://developer.magiclane.com/docs/guides/map-studio/customize-map-style.md';
    const NEW = 'https://developer.magiclane.com/docs/guides/map-studio/tutorials/first-style.md';
    // The copy of the index in memory still lists the old location, which is now gone.
    seedIndex('developer', '- [Customize a Map Style](/docs/guides/map-studio/customize-map-style.md): Rename.\n');
    const { calls, restore } = stubFetch({
      'https://developer.magiclane.com/docs/llms.txt':
        '# Docs\n\n- [First style](/docs/guides/map-studio/tutorials/first-style.md): New.\n',
      [NEW]: '# Your first style\n\nThe page moved here.',
    });
    try {
      const text = textOf(
        await t.client.callTool({
          name: 'get_product_guide',
          arguments: { product: 'map-studio', section: 'customize-map-style' },
        })
      );
      expect(text).toContain('The page moved here.');
      expect(calls.filter((u) => u !== 'https://developer.magiclane.com/docs/llms.txt')).toEqual([OLD, NEW]);
    } finally {
      restore();
    }
  });

  it('does not try the other location when the site fails rather than lacks the page', async () => {
    resetCaches();
    const OLD = 'https://developer.magiclane.com/docs/guides/map-studio/customize-map-style.md';
    seedIndex('developer', '- [Customize a Map Style](/docs/guides/map-studio/customize-map-style.md): Rename.\n');
    const { calls, restore } = stubFetch({
      'https://developer.magiclane.com/docs/llms.txt': () => Promise.reject(new TypeError('fetch failed')),
      [OLD]: () => Promise.reject(new TypeError('fetch failed')),
    });
    try {
      const result = await t.client.callTool({
        name: 'get_product_guide',
        arguments: { product: 'map-studio', section: 'customize-map-style' },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toContain('fetch failed');
      // The listed location only (with its one retry): the other one is on the same unreachable site.
      expect(new Set(calls.filter((u) => u !== 'https://developer.magiclane.com/docs/llms.txt'))).toEqual(
        new Set([OLD])
      );
    } finally {
      restore();
    }
  });

  it('rejects a section that belongs to the other product, listing valid ones', async () => {
    const result = await t.client.callTool({
      name: 'get_product_guide',
      arguments: { product: 'mcp-server', section: 'download-style' },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('does not exist for product "mcp-server"');
    expect(text).toContain('overview, usage-guidelines');
  });

  it('rejects sections outside the schema enum with a validation error', async () => {
    const result = await t.client.callTool({
      name: 'get_product_guide',
      arguments: { product: 'map-studio', section: 'pricing' },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it('rejects an unknown product with a validation error', async () => {
    const result = await t.client.callTool({
      name: 'get_product_guide',
      arguments: { product: 'navigation-sdk' },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it('caps an oversized guide page and says where to continue', async () => {
    seedHttpCache(
      'https://developer.magiclane.com/docs/guides/mcp-server/usage-guidelines.md',
      'x'.repeat(LIMITS.maxDocumentChars + 10)
    );
    const result = await t.client.callTool({ name: 'get_product_guide', arguments: { product: 'mcp-server' } });
    expect(textOf(result)).toContain(
      `(Showing the first ${LIMITS.maxDocumentChars} of ${LIMITS.maxDocumentChars + 10} characters; continue with read_doc, offset: ${LIMITS.maxDocumentChars}.)`
    );
  });

  it('shares the batch budget across the sections of section=all', async () => {
    const share = Math.min(LIMITS.maxDocumentChars, Math.floor(LIMITS.maxBatchChars / 4));
    for (const page of [
      'map-studio',
      'map-studio/create-a-map-style',
      'map-studio/customize-map-style',
      'map-studio/download-style',
    ]) {
      seedHttpCache(`https://developer.magiclane.com/docs/guides/${page}.md`, 'm'.repeat(LIMITS.maxDocumentChars));
    }
    const text = textOf(
      await t.client.callTool({ name: 'get_product_guide', arguments: { product: 'map-studio', section: 'all' } })
    );
    expect([...text.matchAll(/Showing the first (\d+) of/g)].map((m) => Number(m[1]))).toEqual(Array(4).fill(share));
  });

  it('reports per-page failures without failing the whole set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers(),
        text: async () => '',
      })
    );
    // Re-seed only the usage guidelines; the introduction must hit the failing fetch.
    seedFixtures();
    seedHttpCache('https://developer.magiclane.com/docs/guides/mcp-server/usage-guidelines.md', MCP_USAGE);
    const result = await t.client.callTool({
      name: 'get_product_guide',
      arguments: { product: 'mcp-server', section: 'all' },
    });
    const text = textOf(result);
    expect(text).toContain('ERROR: failed to fetch /docs/guides/mcp-server/introduction.md');
    expect(text).toContain('prefer isochrones for reachability questions');
    expect((result as { isError?: boolean }).isError).not.toBe(true);
  });

  it('marks the result as an error when every page fails', async () => {
    seedFixtures(); // clears the seeded guide pages
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const result = await t.client.callTool({
      name: 'get_product_guide',
      arguments: { product: 'map-studio', section: 'all' },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('ERROR: failed to fetch');
    expect(textOf(result)).toContain('network down');
  });
});
