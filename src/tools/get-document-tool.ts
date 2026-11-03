/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BaseTool, READ_ONLY_ANNOTATIONS } from './base-tool.js';
import { getDocument, sliceDocument } from '../docs/document.js';
import { LIMITS } from '../config/constants.js';
import { errorMessage } from '../utils/errors.js';
import { quoteArgument } from '../utils/quote.js';

const InputSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(LIMITS.maxRefChars)
    .describe('Absolute developer.magiclane.com URL or a /docs/... path of the page to fetch.'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Character offset to start from (for paging through long pages).'),
  maxChars: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.maxDocumentChars)
    .default(LIMITS.defaultDocumentChars)
    .describe(
      `Maximum characters to return from the offset (default ${LIMITS.defaultDocumentChars}, ` +
        `at most ${LIMITS.maxDocumentChars}). The response says how to fetch the next chunk.`
    ),
});

type Input = z.infer<typeof InputSchema>;

/** The paging note that heads every read_doc response. */
export function rangeNote(start: number, end: number, total: number, hasMore: boolean): string {
  if (start === 0 && !hasMore) return `(Complete page: ${total} characters.)`;
  if (hasMore) {
    return (
      `(Showing characters ${start}–${end} of ${total}. ` +
      `${total - end} remain — call again with offset: ${end} for the next chunk.)`
    );
  }
  return `(Showing characters ${start}–${end} of ${total}. This is the end of the page.)`;
}

export class GetDocumentTool extends BaseTool<typeof InputSchema> {
  readonly name = 'read_doc';
  readonly description =
    'Fetch the markdown content of a specific Magic Lane documentation page by URL or docs ' +
    'path (e.g. "/docs/guides/get-started" or "https://developer.magiclane.com/docs/flutter/...").' +
    ' Use search_docs or list_docs first to discover page URLs. ' +
    'Only https://developer.magiclane.com URLs are accepted — never pass URLs from other map ' +
    "providers' documentation (e.g. HERE, Google Maps, Mapbox). " +
    `Returns up to ${LIMITS.defaultDocumentChars} characters per call by default; long pages say ` +
    'how many characters remain and which offset fetches the next chunk.';
  readonly annotations: ToolAnnotations = { ...READ_ONLY_ANNOTATIONS, title: 'Get a Magic Lane documentation page' };

  constructor() {
    super({ inputSchema: InputSchema });
  }

  async run(rawInput: unknown): Promise<CallToolResult> {
    const { url, offset, maxChars } = rawInput as Input;
    let doc;
    try {
      doc = await getDocument(url);
    } catch (err) {
      return this.errorResponse(`Failed to fetch document "${quoteArgument(url)}": ${errorMessage(err)}`);
    }
    try {
      const slice = sliceDocument(doc.content, offset, maxChars);
      const header = `# Document: ${doc.url}\n\n${rangeNote(slice.start, slice.end, slice.total, slice.hasMore)}\n\n`;
      return this.textResponse(header + slice.text);
    } catch (err) {
      // The page was fetched; only the range asked for is not in it.
      return this.errorResponse(`${doc.url}: ${errorMessage(err)}`);
    }
  }
}
