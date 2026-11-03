/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The lines a stdio client sends, checked before the SDK's transport reads
 * them. That transport parses each line as a JSON-RPC message and, for a
 * line that is not one, reports the error with nothing to show which message
 * was bad — and answers nothing, though a request with an id is owed an
 * error. This stream passes the good lines on, line by line, and hands each
 * bad one to `onBadLine` with the error and the JSON it held, so the entry
 * point can log what was wrong with which message, and answer it.
 */
import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { ErrorCode, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import type { JSONRPCError } from '@modelcontextprotocol/sdk/types.js';
import { errorLine } from './errors.js';

/** A line the protocol rejected: the error, and the JSON the line held (undefined when it was not JSON). */
export interface BadLine {
  line: string;
  error: unknown;
  message: unknown;
}

/** The SDK transport's own limit on a line: a longer one closes the transport. */
const MAX_LINE_BYTES = 10 * 1024 * 1024;

export class JsonRpcLineGuard extends Transform {
  /** The bytes of a line not yet ended by a newline. */
  private pending: Buffer = Buffer.alloc(0);

  constructor(
    private readonly onBadLine: (bad: BadLine) => void,
    private readonly maxLineBytes: number = MAX_LINE_BYTES
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    let index: number;
    while ((index = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.toString('utf8', 0, index).replace(/\r$/, '');
      this.pending = this.pending.subarray(index + 1);
      this.check(line);
    }
    // A line longer than the transport takes is handed on unfinished, so the
    // transport refuses it, and closes, as it would have on its own.
    if (this.pending.length > this.maxLineBytes) {
      this.push(this.pending);
      this.pending = Buffer.alloc(0);
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    // An unfinished last line goes on as it is: not a message to the transport either.
    if (this.pending.length > 0) this.push(this.pending);
    callback();
  }

  /** Pass a JSON-RPC message on; report anything else. */
  private check(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
      JSONRPCMessageSchema.parse(message);
    } catch (error) {
      this.onBadLine({ line, error, message });
      return;
    }
    this.push(`${line}\n`);
  }
}

/**
 * The error response a bad line is owed, when it is: a request (an object
 * with no `result` or `error` member) whose id is a string or a number. A
 * line with no usable id gets no answer: JSON-RPC would have it answered
 * with id null, which MCP does not allow, and a response is never answered.
 */
export function invalidRequestError(bad: BadLine): JSONRPCError | undefined {
  const { message } = bad;
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return undefined;
  if ('result' in message || 'error' in message) return undefined;
  const id = (message as { id?: unknown }).id;
  if (typeof id !== 'string' && typeof id !== 'number') return undefined;
  return {
    jsonrpc: '2.0',
    id,
    error: { code: ErrorCode.InvalidRequest, message: `Invalid Request: ${errorLine(bad.error)}` },
  };
}
