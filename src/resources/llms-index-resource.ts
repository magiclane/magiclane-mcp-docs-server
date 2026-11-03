/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { DOCS } from '../config/constants.js';
import { indexText } from '../docs/docs-index.js';
import { trackCall } from '../utils/calls-in-flight.js';
import { withRequestContext } from '../utils/request-context.js';

/**
 * Expose the raw llms.txt documentation indexes as MCP resources: served from
 * the index memo the tools use (one download for both), and dropped when the
 * client cancels the read. A read counts among the calls running (see
 * utils/calls-in-flight.ts): the stdio server waits for it, as for a tool
 * call, when the client closes stdin.
 */
export function registerLlmsIndexResources(server: McpServer): void {
  for (const source of DOCS.sources) {
    server.registerResource(
      `llms-txt-${source.id}`,
      source.indexUrl,
      {
        title: `${source.name} — llms.txt index`,
        description: `Raw llms.txt documentation index for ${source.name}.`,
        mimeType: 'text/markdown',
      },
      (uri, extra) => trackCall(readIndex(uri.toString(), source.id, extra.signal))
    );
  }
}

/** The index of `sourceId` as the resource's one markdown content. */
async function readIndex(uri: string, sourceId: string, signal: AbortSignal | undefined): Promise<ReadResourceResult> {
  return {
    contents: [
      {
        uri,
        mimeType: 'text/markdown',
        text: await withRequestContext({ signal }, () => indexText(sourceId)),
      },
    ],
  };
}
