/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { errorLine, errorMessage, messageLabel, protocolErrorLine } from '../../src/utils/errors.js';
import { MAX_QUOTED_CHARS } from '../../src/utils/quote.js';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('errorMessage', () => {
  it('returns the message of an Error and stringifies anything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
  });

  it('says why a network fetch failed, from its cause', () => {
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
    });
    expect(errorMessage(refused)).toBe('fetch failed (ECONNREFUSED)');
    expect(errorMessage(new TypeError('fetch failed', { cause: new Error('other side closed') }))).toBe(
      'fetch failed (other side closed)'
    );
    expect(errorMessage(new TypeError('fetch failed', { cause: {} }))).toBe('fetch failed');
    expect(errorMessage(new TypeError('fetch failed', { cause: null }))).toBe('fetch failed');
    expect(errorMessage(new TypeError('fetch failed'))).toBe('fetch failed');
    expect(errorMessage(new Error('other', { cause: new Error('x') }))).toBe('other');
  });

  it('logs an error as one line: a schema error as its issues, folded and bounded', () => {
    const schema = z.object({ jsonrpc: z.literal('2.0'), params: z.object({ name: z.string() }) });
    const result = schema.safeParse({ jsonrpc: '1.0', params: { name: 1 } });
    expect(result.success).toBe(false);
    const line = errorLine(result.success ? undefined : result.error);
    expect(line).toBe('jsonrpc: Invalid literal value, expected "2.0"; params.name: Expected string, received number');
    expect(line).not.toContain('\n');
    expect(errorLine(new Error('two\n  lines'))).toBe('two lines');
    expect(errorLine('x'.repeat(400))).toHaveLength(300);
    expect(errorLine('x'.repeat(400)).endsWith('…')).toBe(true);
    expect(errorLine({ issues: [{ message: 'top-level' }] })).toBe('top-level');
  });

  it('cuts a long line between characters: an emoji across the cut is left out whole', () => {
    const atCut = `${'k'.repeat(298)}${'😀'.repeat(20)}`; // the cut at 299 would keep a high surrogate alone
    expect(errorLine(atCut)).toBe(`${'k'.repeat(298)}…`);
    const beforeCut = `${'k'.repeat(297)}${'😀'.repeat(20)}`; // the emoji ends right at the cut
    expect(errorLine(beforeCut)).toBe(`${'k'.repeat(297)}😀…`);
    // A request with an odd key name: the issue quotes it (and the Invalid Request answer, this line).
    for (let n = 212; n < 236; n++) {
      const result = JSONRPCMessageSchema.safeParse({
        jsonrpc: '2.0',
        id: 7,
        method: 'ping',
        params: [1],
        [`${'k'.repeat(n)}${'😀'.repeat(20)}`]: 1,
      });
      const line = errorLine(result.success ? undefined : result.error);
      expect(line.length).toBeLessThanOrEqual(300);
      expect(LONE_SURROGATE.test(line)).toBe(false);
    }
  });

  it("names the closest shape's issues for a message the SDK's schema rejects, not 'Invalid input'", () => {
    // The SDK checks each message against the union of request, notification,
    // response and error (zod v4): one issue, "Invalid input", branches nested.
    const rejected = (message: unknown): string => {
      const result = JSONRPCMessageSchema.safeParse(message);
      expect(result.success).toBe(false);
      return errorLine(result.success ? undefined : result.error);
    };
    expect(rejected({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: ['x'] })).toBe(
      'params: Invalid input: expected object, received array'
    );
    expect(rejected({ id: 2, method: 'ping' })).toBe('jsonrpc: Invalid input: expected "2.0"');
    expect(rejected({ jsonrpc: '1.0', id: 3, method: 'ping' })).toBe('jsonrpc: Invalid input: expected "2.0"');
    expect(rejected({ jsonrpc: '2.0', id: 4, method: 7 })).toBe(
      'method: Invalid input: expected string, received number'
    );
    // The id is a union itself (string | number): the inner issue, at the id's path.
    expect(rejected({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' })).toBe(
      'id: Invalid input: expected string, received object'
    );
    expect(rejected({ jsonrpc: '2.0', id: 5, result: {}, error: { code: 1, message: 'x' } })).toBe(
      'Unrecognized key: "error"'
    );
    expect(rejected([])).toBe('Invalid input: expected object, received array');
    // A zod v3 union keeps its branches in unionErrors; nested unions are followed.
    const v3 = z.union([z.object({ a: z.string() }), z.object({ a: z.number(), b: z.string() })]);
    const result = v3.safeParse({ a: true });
    expect(errorLine(result.success ? undefined : result.error)).toBe('a: Expected string, received boolean');
    const nested = z.union([z.object({ k: z.union([z.literal('x'), z.literal('y')]) }), z.string()]);
    const inner = nested.safeParse({ k: 'z' });
    expect(errorLine(inner.success ? undefined : inner.error)).toBe('k: Invalid literal value, expected "x"');
    expect(errorLine({ issues: [{ code: 'invalid_union', message: 'bare' }] })).toBe('bare'); // no branches at all
    expect(errorLine({ issues: [{ code: 'invalid_union', errors: [], unionErrors: [] }] })).toBe('undefined');
    // Issues without paths at all (not zod's, but errorLine takes any issue list).
    expect(errorLine({ issues: [{ code: 'invalid_union', errors: [[{ message: 'inner' }]] }] })).toBe('inner');
  });

  it('labels a bad message by what it had of a method and an id', () => {
    expect(messageLabel({ jsonrpc: '2.0', id: 'b', method: 'tools/call' })).toBe(' (method tools/call, id "b")');
    expect(messageLabel({ id: 7 })).toBe(' (id 7)');
    expect(messageLabel({ method: 42, id: { a: 1 } })).toBe('');
    expect(messageLabel({ method: 'ping' })).toBe(' (method ping)');
    expect(messageLabel(undefined)).toBe('');
    expect(messageLabel('x')).toBe('');
    expect(messageLabel(null)).toBe('');
  });

  it("keeps the client's method and id on one line, cut short: they cannot forge a log line nor make a long one", () => {
    const forged = messageLabel({ id: 11, method: 'tools/call\nFAKE-LOG-LINE: everything is fine' });
    expect(forged).toBe(' (method tools/call FAKE-LOG-LINE: everything is fine, id 11)');
    expect(messageLabel({ method: 'ping\r\u2028x' })).toBe(' (method ping x)');
    const long = messageLabel({ method: 'm'.repeat(1_000_000), id: 'i'.repeat(1_000_000) });
    expect(long).toBe(` (method ${'m'.repeat(MAX_QUOTED_CHARS)}…, id "${'i'.repeat(MAX_QUOTED_CHARS - 1)}…)`);
  });

  it('writes a protocol error as one line of at most 300 characters in all', () => {
    const params = { jsonrpc: '2.0', id: 'bad', method: 'tools/call', params: ['x'] };
    const result = JSONRPCMessageSchema.safeParse(params);
    expect(protocolErrorLine(result.success ? undefined : result.error, params)).toBe(
      'MCP protocol error (method tools/call, id "bad"): params: Invalid input: expected object, received array'
    );
    expect(protocolErrorLine(new Error('ReadBuffer exceeded'))).toBe('MCP protocol error: ReadBuffer exceeded');
    const forged = protocolErrorLine(new Error('Invalid input'), { id: 11, method: 'tools/call\nFAKE-LOG-LINE: x' });
    expect(forged.split('\n')).toHaveLength(1);
    const huge = protocolErrorLine(new Error('e'.repeat(1_000)), {
      id: 'i'.repeat(1_000_000),
      method: 'm'.repeat(1_000_000),
    });
    expect(huge).toHaveLength(300);
    expect(huge.endsWith('…')).toBe(true);
    // An emoji across the cut is left out whole.
    for (let pad = 0; pad < 4; pad++) {
      const line = protocolErrorLine(new Error(`${'x'.repeat(pad)}${'😀'.repeat(200)}`));
      expect(LONE_SURROGATE.test(line)).toBe(false);
      expect(line.length).toBeLessThanOrEqual(300);
    }
  });
});
