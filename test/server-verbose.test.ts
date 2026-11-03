/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Isolated file: VERBOSE must be set before the server module graph loads,
 * so the whole file runs with verbose logging enabled.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.VERBOSE = 'true';

describe('tool invocation logging with VERBOSE=true', () => {
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    vi.resetModules();
    const { createServer } = await import('../src/server.js');
    const { seedHttpCache } = await import('../src/utils/http-client.js');
    const { seedIndex } = await import('../src/docs/docs-index.js');
    const { seedFullTextSections } = await import('../src/docs/full-text.js');
    const { DOCS } = await import('../src/config/constants.js');

    // Seed every index so the calls below never touch the network.
    for (const source of DOCS.sources) {
      const index = `- [Seeded ${source.id}](/docs/${source.id}/seeded.md): Seeded page.\n`;
      seedIndex(source.id, index);
      seedHttpCache(source.indexUrl, index);
      seedFullTextSections(source.id, `## Docs\n\n### Seeded ${source.id}\n\nBody.\n`);
    }

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    client = new Client({ name: 'verbose-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => {
      await client.close();
      await server.close();
    };
  });

  afterAll(async () => {
    await close();
    delete process.env.VERBOSE;
  });

  beforeEach(() => {
    stderr.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('logs the tool name when a tool is invoked', async () => {
    await client.callTool({ name: 'list_docs', arguments: { source: 'developer' } });
    expect(stderr).toHaveBeenCalledWith('[Magic Lane MCP Docs] tool invoked: list_docs');
  });

  it('logs each invocation separately, naming the tool that ran', async () => {
    await client.callTool({ name: 'search_docs', arguments: { query: 'seeded' } });
    await client.callTool({ name: 'find_across_sdks', arguments: { query: 'seeded' } });
    const lines = stderr.mock.calls.map((call) => call[0]);
    expect(lines).toContain('[Magic Lane MCP Docs] tool invoked: search_docs');
    expect(lines).toContain('[Magic Lane MCP Docs] tool invoked: find_across_sdks');
  });

  it('does not log for resource reads', async () => {
    await client.readResource({ uri: 'https://developer.magiclane.com/docs/llms.txt' });
    const toolLines = stderr.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('tool invoked'));
    expect(toolLines).toEqual([]);
  });

  it('still returns the tool result unchanged', async () => {
    const result = await client.callTool({
      name: 'list_docs',
      arguments: { source: 'developer' },
    });
    const content = (result as { content: Array<{ text: string }> }).content;
    expect(content[0].text).toContain('Seeded developer');
  });
});
