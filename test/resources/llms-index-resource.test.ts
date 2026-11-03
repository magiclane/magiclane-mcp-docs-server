/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearIndexCache } from '../../src/docs/docs-index.js';
import { callsInFlight, callsSettled } from '../../src/utils/calls-in-flight.js';
import { connectClient, DEVELOPER_LLMS, DEVELOPER_SOURCE, seedFixtures } from '../helpers.js';
import type { TestClient } from '../helpers.js';

describe('llms.txt index resources', () => {
  let t: TestClient;

  beforeEach(async () => {
    seedFixtures();
    t = await connectClient();
  });

  afterEach(async () => {
    await t.close();
  });

  it('lists a titled markdown resource per source', async () => {
    const { resources } = await t.client.listResources();
    expect(resources).toHaveLength(7);
    for (const resource of resources) {
      expect(resource.name).toMatch(/^llms-txt-/);
      expect(resource.mimeType).toBe('text/markdown');
      expect(resource.title ?? resource.name).toBeTruthy();
    }
  });

  it('reads the raw llms.txt content for a source', async () => {
    const result = await t.client.readResource({ uri: DEVELOPER_SOURCE.indexUrl });
    const first = result.contents[0] as { uri: string; mimeType?: string; text?: string };
    expect(first.uri).toBe(DEVELOPER_SOURCE.indexUrl);
    expect(first.mimeType).toBe('text/markdown');
    expect(first.text).toBe(DEVELOPER_LLMS);
  });

  it('counts a read among the calls running until it is answered, like a tool call', async () => {
    clearIndexCache(); // the index must be downloaded: the read waits on the site
    let answer!: (res: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)))
    );
    try {
      await callsSettled();
      expect(callsInFlight()).toBe(0);
      const reading = t.client.readResource({ uri: DEVELOPER_SOURCE.indexUrl });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(callsInFlight()).toBe(1); // the stdio server waits for it when stdin closes
      answer(new Response(DEVELOPER_LLMS, { status: 200, headers: { 'content-type': 'text/plain' } }));
      const result = await reading;
      expect((result.contents[0] as { text?: string }).text).toBe(DEVELOPER_LLMS);
      await callsSettled();
      expect(callsInFlight()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('serves the same index the tools read, without a second download', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await t.client.callTool({ name: 'search_docs', arguments: { query: 'markers' } });
      await t.client.readResource({ uri: DEVELOPER_SOURCE.indexUrl });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
