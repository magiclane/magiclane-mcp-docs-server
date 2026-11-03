/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * End-to-end integration: spawns the BUILT stdio server (dist bundle) and
 * exercises the MCP protocol against the LIVE documentation site: every
 * published index loads and lists its pages, the page contents split into
 * those pages (every excerpt has a URL), a missing page is a tool error, and
 * the longest live page reads to its end. One check runs in this process: the
 * live page contents split into exactly the pages each index lists, so pages
 * with their own level-3 headings stay whole. The offline checks of the built bundle
 * (tools, resources) are in built-bundle.test.ts; the tools themselves are
 * covered by the offline unit suite.
 *
 * Opt-in: it needs the network and a build, so it runs only under
 * `npm run test:live` (LIVE_DOCS_TESTS=1) — never as part of the offline
 * `npm test`. When opted in, a missing build is a failure, not a skip.
 * Timeouts are governed by `testTimeout` in vitest.config.ts.
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOCS, LIMITS } from '../src/config/constants.js';
import { loadIndex } from '../src/docs/docs-index.js';
import { loadFullTextSections } from '../src/docs/full-text.js';

const entry = process.env.MCP_STDIO_ENTRY ?? 'dist/docs-server.esm.js';
const live = Boolean(process.env.LIVE_DOCS_TESTS);

interface JsonRpcResponse {
  id?: number;
  result?: any;
  error?: { code: number; message: string };
}

describe.runIf(live)('stdio integration (built server, live docs)', () => {
  let child: ChildProcess;
  const pending = new Map<number, (msg: JsonRpcResponse) => void>();
  let rejectAll: ((err: Error) => void) | null = null;
  let nextId = 1;

  function request(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const previousRejectAll = rejectAll;
      rejectAll = (err) => {
        previousRejectAll?.(err);
        reject(err);
      };
      pending.set(id, resolve);
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  function notify(method: string, params: unknown): void {
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  beforeAll(async () => {
    // Opted in: a missing build is a failure, not a skip.
    expect(existsSync(entry), `run \`npm run build\` before \`npm run test:live\` (${entry} is missing)`).toBe(true);
    child = spawn('node', [entry], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      }
    });
    child.on('exit', (code: number | null) => {
      rejectAll?.(new Error(`server exited early with code ${code} (entry: ${entry})`));
    });

    const init = await request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '0.0.0' },
    });
    expect(init.result.serverInfo.name).toBe('@magiclane/mcp-docs-server');
    notify('notifications/initialized', {});
  });

  afterAll(() => {
    rejectAll = null;
    child?.kill();
  });

  it('loads every published index and lists the pages they hold', async () => {
    const listing = await request('tools/call', { name: 'list_docs', arguments: { source: 'all', limit: 1 } });
    expect(listing.result.isError).not.toBe(true);
    // 781 pages on 12 October 2026: a far smaller count means a file came back cut or empty.
    expect(listing.result.structuredContent.total).toBeGreaterThan(600);
    expect(listing.result.structuredContent.failedSources).toEqual([]);
  });

  it('splits every page-contents file into the pages its index lists, with a URL on every excerpt', async () => {
    const search = await request('tools/call', {
      name: 'search_docs',
      arguments: { query: 'calculate route', includeFullText: true, limit: 5 },
    });
    expect(search.result.isError).not.toBe(true);
    const { excerpts, failedSources } = search.result.structuredContent;
    expect(failedSources).toEqual([]);
    expect(excerpts.length).toBeGreaterThan(0);
    for (const e of excerpts) expect(e.url, e.title).toMatch(/^https:\/\/developer\.magiclane\.com\/docs\//);
  });

  it('keeps every live page whole: the page contents split into exactly the pages each index lists', async () => {
    // In this process, against the live files: a page with its own "---" and
    // "### Heading" (Apply Map Style, Basic Shape Drawer) must stay one page.
    const index = await loadIndex();
    expect(index.failed).toEqual([]);
    const { sections, failed } = await loadFullTextSections(undefined, index);
    expect(failed).toEqual([]);
    for (const source of DOCS.sources.filter((s) => s.fullTextUrl)) {
      const listed = index.entries.filter((e) => e.source === source.id).map((e) => e.title);
      const pages = sections.filter((p) => p.source === source.id).map((p) => p.title);
      expect(pages, source.id).toEqual(listed);
    }
    expect(sections.every((p) => p.path !== undefined)).toBe(true);
  });

  it('reports a page the site does not have as a tool error, not a crash', async () => {
    const missing = await request('tools/call', {
      name: 'read_doc',
      arguments: { url: '/docs/flutter/guides/no-such-page-for-the-live-check' },
    });
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0].text).toMatch(/404|not found/i);
  });

  it('reads the end of the longest page (past the old 200k cap)', async () => {
    const doc = await request('tools/call', {
      name: 'read_doc',
      arguments: {
        url: '/docs/cloud-rest-api/guides/fleet-management/core-concepts/optimization',
        offset: 240_000,
        maxChars: LIMITS.maxDocumentChars, // the page's last ~28k characters fit in one maximal slice
      },
    });
    expect(doc.result.isError).not.toBe(true);
    const text = doc.result.content[0].text as string;
    expect(text).toMatch(/of 2\d\d,?\d{3}\. This is the end of the page\./);
    expect(text).toContain('Delete Order');
  });
});
