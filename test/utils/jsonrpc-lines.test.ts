/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { invalidRequestError, JsonRpcLineGuard } from '../../src/utils/jsonrpc-lines.js';
import type { BadLine } from '../../src/utils/jsonrpc-lines.js';

/** Runs `chunks` through a guard; resolves with what came out and the lines it reported. */
function feed(chunks: string[], maxLineBytes?: number): Promise<{ out: string; bad: BadLine[] }> {
  return new Promise((resolve) => {
    const bad: BadLine[] = [];
    const guard = new JsonRpcLineGuard((line) => bad.push(line), maxLineBytes);
    let out = '';
    guard.on('data', (chunk: Buffer) => (out += chunk.toString()));
    guard.on('end', () => resolve({ out, bad }));
    for (const chunk of chunks) guard.write(chunk);
    guard.end();
  });
}

const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
const note = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });

describe('JsonRpcLineGuard', () => {
  it('passes JSON-RPC messages on, one line each, however the chunks split them', async () => {
    const text = `${ping}\n${note}\r\n`;
    const { out, bad } = await feed([text.slice(0, 7), text.slice(7, 30), text.slice(30)]);
    expect(out).toBe(`${ping}\n${note}\n`); // the CR is gone, as the transport would drop it
    expect(bad).toEqual([]);
  });

  it('keeps back a line that is not JSON-RPC, and reports it with the error and the JSON it held', async () => {
    const badCall = JSON.stringify({ jsonrpc: '2.0', id: 'b', method: 'tools/call', params: ['x'] });
    const { out, bad } = await feed([`not json\n${badCall}\n${ping}\n\n`]);
    expect(out).toBe(`${ping}\n`);
    expect(bad).toHaveLength(3);
    expect(bad[0]?.line).toBe('not json');
    expect(bad[0]?.error).toBeInstanceOf(SyntaxError);
    expect(bad[0]?.message).toBeUndefined();
    expect(bad[1]?.message).toEqual(JSON.parse(badCall));
    expect((bad[1]?.error as { issues?: unknown[] }).issues).toHaveLength(1);
    expect(bad[2]?.line).toBe(''); // an empty line is not a message either
  });

  it('hands an unfinished line on as it is: one over the limit at once, the last one at the end', async () => {
    const long = 'x'.repeat(40);
    const { out, bad } = await feed([`${ping}\n${long}`, `${long}y`], 50); // 81 bytes pending: over the limit
    expect(out).toBe(`${ping}\n${long}${long}y`);
    expect(bad).toEqual([]);
    const tail = await feed([`${ping}\n{"jsonrpc":`]);
    expect(tail.out).toBe(`${ping}\n{"jsonrpc":`);
  });
});

describe('invalidRequestError', () => {
  const bad = (message: unknown): BadLine => ({ line: JSON.stringify(message), error: new Error('why'), message });

  it('answers a request with a string or number id with Invalid Request, saying why', () => {
    expect(invalidRequestError(bad({ jsonrpc: '2.0', id: 'b', method: 'tools/call', params: ['x'] }))).toEqual({
      jsonrpc: '2.0',
      id: 'b',
      error: { code: ErrorCode.InvalidRequest, message: 'Invalid Request: why' },
    });
    expect(invalidRequestError(bad({ jsonrpc: '1.0', id: 7, method: 'ping' }))?.id).toBe(7);
    expect(invalidRequestError(bad({ id: 7, method: 42 }))?.id).toBe(7); // not a method, but a request with an id
  });

  it('answers nothing without a usable id, and never a response', () => {
    for (const message of [
      undefined, // not JSON
      'x',
      [{ jsonrpc: '2.0', id: 1, method: 'ping' }], // a batch
      {},
      { jsonrpc: '2.0', method: 'ping' }, // a notification
      { jsonrpc: '2.0', id: null, method: 'ping' },
      { jsonrpc: '2.0', id: { a: 1 }, method: 'ping' },
      { jsonrpc: '2.0', id: 5, result: {}, error: { code: 1, message: 'x' } },
      { jsonrpc: '2.0', id: 5, result: 'bad' },
    ]) {
      expect(invalidRequestError(bad(message)), JSON.stringify(message)).toBeUndefined();
    }
  });
});
