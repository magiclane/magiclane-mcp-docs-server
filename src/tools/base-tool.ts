/**
 * SPDX-FileCopyrightText: 2025-2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Abstract base class for this server's MCP tools, adapted from the shared
 * BaseTool pattern in magiclane-mcp-server. This is a documentation (text)
 * server, so responses carry markdown text rather than JSON, and the geospatial
 * server's image / MCP-logging / output-validation helpers are omitted as not
 * applicable here.
 *
 * Each tool subclass declares its `name`, `description`, `annotations` and Zod
 * input schema and implements `run()`. `installTo()` registers the tool, logs
 * invocations when VERBOSE is set, and turns an unexpected throw into an
 * `isError` result so nothing ever throws across the protocol.
 */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AnyZodObject, ZodRawShape, ZodTypeAny } from 'zod';
import { trackCall } from '../utils/calls-in-flight.js';
import { errorMessage } from '../utils/errors.js';
import { webPageLinks, webPageUrls } from '../utils/page-links.js';
import { logToolInvocation } from '../utils/logger.js';
import { currentRequest, withRequestContext } from '../utils/request-context.js';

export { webPageLinks } from '../utils/page-links.js';

/**
 * Read-only annotation defaults shared by every tool: this server only reads
 * public documentation, so clients may skip confirmation prompts. Subclasses
 * spread these and add their own `title`.
 */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * @template InputSchema - Zod schema for input validation
 * @template OutputSchema - Zod schema for output validation (optional)
 */
export abstract class BaseTool<InputSchema extends ZodTypeAny, OutputSchema extends ZodTypeAny = ZodTypeAny> {
  /** Unique tool identifier used for MCP registration (short snake_case verb phrase). */
  abstract readonly name: string;

  /** Human-readable description the agent reads to decide when to call the tool. */
  abstract readonly description: string;

  /** Tool metadata annotations (title + read-only hints). */
  abstract readonly annotations: ToolAnnotations;

  /** Zod schema for runtime input validation and type inference. */
  readonly inputSchema: InputSchema;

  /** Optional Zod schema advertised as the tool's structured output. */
  readonly outputSchema?: OutputSchema;

  constructor(params: { inputSchema: InputSchema; outputSchema?: OutputSchema }) {
    this.inputSchema = params.inputSchema;
    this.outputSchema = params.outputSchema;
  }

  /**
   * Register this tool with the MCP server. Hands the SDK the strict input
   * object and the output object's `shape`, wraps the callback with VERBOSE invocation logging, and
   * converts any unexpected throw into an `isError` result.
   */
  installTo(server: McpServer): RegisteredTool {
    const config = {
      title: this.annotations.title,
      description: this.description,
      // The object itself, made strict: a misspelled or unknown argument is an
      // input error ("Unrecognized key"), as the advertised
      // additionalProperties: false says, instead of being dropped unseen.
      inputSchema: (this.inputSchema as unknown as AnyZodObject).strict(),
      annotations: this.annotations,
    } as {
      title?: string;
      description: string;
      inputSchema: AnyZodObject;
      outputSchema?: ZodRawShape;
      annotations: ToolAnnotations;
    };

    if (this.outputSchema) {
      config.outputSchema = (this.outputSchema as unknown as { shape: ZodRawShape }).shape;
    }

    const handler = (rawInput: unknown, extra: unknown): Promise<CallToolResult> => {
      logToolInvocation(this.name);
      // The SDK aborts `extra.signal` when the request is cancelled (the HTTP
      // client went away; over stdio, notifications/cancelled); fetches made for
      // this call follow it, and the HTTP app keeps the request's slot until
      // the work has really stopped.
      const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
      const work = withRequestContext({ signal }, async () => {
        try {
          return await this.run(rawInput, extra);
        } catch (err) {
          // Public documentation has nothing secret to leak, so surface the
          // reason — but never throw across the protocol.
          return this.errorResponse(`${this.name} failed: ${errorMessage(err)}`);
        }
      });
      currentRequest()?.track?.(work);
      // Counted among the calls running (see utils/calls-in-flight.ts) until
      // the SDK has written the result.
      return trackCall(work);
    };

    // The SDK's registerTool overloads are keyed off the (statically unknown here)
    // schema shape, so the config and handler are bridged through `any`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return server.registerTool(this.name, config as any, handler as any);
  }

  /**
   * Tool logic, implemented by subclasses. `rawInput` has already been validated
   * by the SDK against `inputSchema` before this runs. `extra` (request metadata)
   * is passed through but unused by the documentation tools.
   */
  abstract run(rawInput: unknown, extra?: unknown): Promise<CallToolResult>;

  /** Markdown text response, optionally carrying structured output. Page links are given as web pages (see webPageLinks). */
  protected textResponse(text: string, structuredContent?: Record<string, unknown>): CallToolResult {
    return {
      content: [{ type: 'text' as const, text: webPageLinks(text) }],
      ...(structuredContent ? { structuredContent: webPageUrls(structuredContent) as Record<string, unknown> } : {}),
    };
  }

  /** Error response: the message as text, flagged with `isError: true`. */
  protected errorResponse(message: string): CallToolResult {
    return {
      content: [{ type: 'text' as const, text: webPageLinks(message) }],
      isError: true,
    };
  }
}

/**
 * A tool with its schema generics erased — the type of a heterogeneous tool
 * list. Sound because `inputSchema` / `outputSchema` are readonly (covariant),
 * so any concrete `BaseTool<SomeZodObject>` is assignable to it.
 */
export type AnyTool = BaseTool<ZodTypeAny, ZodTypeAny>;
