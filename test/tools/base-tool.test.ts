/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BaseTool, READ_ONLY_ANNOTATIONS, webPageLinks } from '../../src/tools/base-tool.js';
import { callsInFlight, callsSettled } from '../../src/utils/calls-in-flight.js';

const EmptySchema = z.object({});

/** A tool whose run() throws, to exercise installTo's error wrapping. */
class ThrowingTool extends BaseTool<typeof EmptySchema> {
  readonly name = 'throwing_tool';
  readonly description = 'Always throws, for testing.';
  readonly annotations = { ...READ_ONLY_ANNOTATIONS, title: 'Throwing tool' };
  constructor(private readonly thrown: unknown) {
    super({ inputSchema: EmptySchema });
  }
  async run(): Promise<CallToolResult> {
    throw this.thrown;
  }
}

/** A tool that answers when told to, to watch the calls in flight. */
class HeldTool extends BaseTool<typeof EmptySchema> {
  readonly name = 'held_tool';
  readonly description = 'Answers when released, for testing.';
  readonly annotations = { ...READ_ONLY_ANNOTATIONS, title: 'Held tool' };
  readonly release: Array<(fail: boolean) => void> = [];
  constructor() {
    super({ inputSchema: EmptySchema });
  }
  run(): Promise<CallToolResult> {
    return new Promise((resolve, reject) =>
      this.release.push((fail) => (fail ? reject(new Error('held failure')) : resolve(this.textResponse('released'))))
    );
  }
}

/** A trivial tool that succeeds, to confirm the happy path returns unchanged. */
class OkTool extends BaseTool<typeof EmptySchema> {
  readonly name = 'ok_tool';
  readonly description = 'Returns a fixed string.';
  readonly annotations = { ...READ_ONLY_ANNOTATIONS, title: 'Ok tool' };
  constructor() {
    super({ inputSchema: EmptySchema });
  }
  async run(): Promise<CallToolResult> {
    return this.textResponse('ok');
  }
}

async function connectWith(...tools: BaseTool<typeof EmptySchema>[]): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = new McpServer({ name: 'base-tool-test', version: '0.0.0' });
  for (const tool of tools) tool.installTo(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'base-tool-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]?.text ?? '';
}

describe('BaseTool.installTo error wrapping', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('turns a thrown Error into an isError result carrying the message', async () => {
    const t = await connectWith(new ThrowingTool(new Error('boom')));
    close = t.close;
    const result = await t.client.callTool({ name: 'throwing_tool', arguments: {} });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toBe('throwing_tool failed: boom');
  });

  it('stringifies a thrown non-Error value', async () => {
    const t = await connectWith(new ThrowingTool('plain rejection'));
    close = t.close;
    const result = await t.client.callTool({ name: 'throwing_tool', arguments: {} });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toBe('throwing_tool failed: plain rejection');
  });

  it('returns a successful run() result unchanged', async () => {
    const t = await connectWith(new OkTool());
    close = t.close;
    const result = await t.client.callTool({ name: 'ok_tool', arguments: {} });
    expect((result as { isError?: boolean }).isError).not.toBe(true);
    expect(textOf(result)).toBe('ok');
  });
});

describe('tool calls in flight', () => {
  it('counts the calls running and settles once the last one, failed or not, has answered', async () => {
    const held = new HeldTool();
    const { client, close } = await connectWith(held);
    try {
      await callsSettled(); // the earlier tests' calls, written and gone
      expect(callsInFlight()).toBe(0);
      await expect(callsSettled()).resolves.toBeUndefined(); // nothing to wait for
      const first = client.callTool({ name: 'held_tool', arguments: {} });
      const second = client.callTool({ name: 'held_tool', arguments: {} });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(callsInFlight()).toBe(2);
      let settled = false;
      const waiting = callsSettled().then(() => (settled = true));
      held.release[0]!(false);
      await first;
      await new Promise((resolve) => setTimeout(resolve, 10)); // the entry goes once the result is written
      expect(callsInFlight()).toBe(1);
      expect(settled).toBe(false);
      // A call started while the wait is on is waited for too.
      const third = client.callTool({ name: 'held_tool', arguments: {} });
      await new Promise((resolve) => setTimeout(resolve, 10));
      held.release[1]!(true); // a failure is an answer (an isError result), not a throw
      expect((await second).isError).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      expect(callsInFlight()).toBe(1);
      held.release[2]!(false);
      await third;
      await waiting;
      expect(settled).toBe(true);
      expect(callsInFlight()).toBe(0);
    } finally {
      await close();
    }
  });
});

describe('webPageLinks', () => {
  it('links documentation pages as the web pages people open, not their .md twins', () => {
    expect(
      webPageLinks(
        '[Get Started](https://developer.magiclane.com/docs/guides/get-started.md) — see ' +
          'https://developer.magiclane.com/docs/a.md#anchor, https://developer.magiclane.com/docs/b.md?x=1 and ' +
          '"https://developer.magiclane.com/docs/c.md". End: https://developer.magiclane.com/docs/d.md'
      )
    ).toBe(
      '[Get Started](https://developer.magiclane.com/docs/guides/get-started) — see ' +
        'https://developer.magiclane.com/docs/a#anchor, https://developer.magiclane.com/docs/b?x=1 and ' +
        '"https://developer.magiclane.com/docs/c". End: https://developer.magiclane.com/docs/d'
    );
    // Not page links: the index files, other extensions, other hosts.
    const others =
      'https://developer.magiclane.com/docs/llms.txt https://developer.magiclane.com/docs/x.mdx https://example.com/docs/a.md';
    expect(webPageLinks(others)).toBe(others);
  });

  it('links the relative, http:// and .MD forms page text holds, but keeps the address a fetch failed for', () => {
    expect(
      webPageLinks(
        'See [Routing](/docs/flutter/guides/routing.md#calc), **[Maps](/docs/flutter/maps.MD)** and ' +
          'http://developer.magiclane.com/docs/x.md.'
      )
    ).toBe(
      'See [Routing](https://developer.magiclane.com/docs/flutter/guides/routing#calc), ' +
        '**[Maps](https://developer.magiclane.com/docs/flutter/maps)** and https://developer.magiclane.com/docs/x.'
    );
    // Bold, italic and table-cell forms.
    expect(
      webPageLinks('**https://developer.magiclane.com/docs/a.md** | https://developer.magiclane.com/docs/b.md |')
    ).toBe('**https://developer.magiclane.com/docs/a** | https://developer.magiclane.com/docs/b |');
    const failed = 'HTTP 404 Not Found for https://developer.magiclane.com/docs/flutter/no-such-page.md';
    expect(webPageLinks(failed)).toBe(failed);
    // A relative link to something that is not a page stays.
    expect(webPageLinks('[img](/docs/a.png) [idx](/docs/llms.txt)')).toBe('[img](/docs/a.png) [idx](/docs/llms.txt)');
  });

  it('links a page whose path holds an underscore, plain, in a link, bold, italic or in a table cell', () => {
    const page = 'https://developer.magiclane.com/docs/ios/examples/maps-3dscene/map_update';
    expect(webPageLinks(`${page}.md`)).toBe(page);
    expect(webPageLinks(`[Map Update](${page}.md#x) — ${page}.md.`)).toBe(`[Map Update](${page}#x) — ${page}.`);
    const marked = (ext: string) =>
      `**https://developer.magiclane.com/docs/a_b${ext}** _https://developer.magiclane.com/docs/a_b${ext}_ ` +
      `| https://developer.magiclane.com/docs/a_b${ext} |`;
    expect(webPageLinks(marked('.md'))).toBe(marked(''));
  });
});
