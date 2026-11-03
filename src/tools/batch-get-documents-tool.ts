/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BaseTool, READ_ONLY_ANNOTATIONS } from './base-tool.js';
import { LIMITS } from '../config/constants.js';
import { getDocument, normalizeDocRef, sliceDocument } from '../docs/document.js';
import type { FetchedDocument } from '../docs/document.js';
import { withRequestContext } from '../utils/request-context.js';
import { errorMessage } from '../utils/errors.js';
import { isLoadFailure } from '../utils/http-client.js';
import { quoteArgument } from '../utils/quote.js';

const InputSchema = z.object({
  urls: z
    .array(z.string().min(1).max(LIMITS.maxRefChars))
    .min(1)
    .max(LIMITS.maxBatchSize)
    .describe('Absolute developer.magiclane.com URLs or /docs/... paths to fetch.'),
});

type Input = z.infer<typeof InputSchema>;

/** The least a page gets when the batch budget is shared, so no page is cut to nothing. */
const MIN_CHARS_PER_PAGE = 2_000;

/** A page's identity: its normalized URL, or the reference as given when it is not a valid one. */
function pageKey(ref: string): string {
  try {
    return normalizeDocRef(ref).url;
  } catch {
    return ref;
  }
}

/**
 * The most any one page gets of `budget`, shared over pages of these lengths:
 * the pages shorter than an even share come whole, and what they leave is
 * shared evenly among the longer ones — in whatever order they were given.
 */
export function shareBudget(lengths: number[], budget: number): number {
  let left = budget;
  let pages = lengths.length;
  for (const length of [...lengths].sort((a, b) => a - b)) {
    const share = Math.floor(left / pages);
    if (length > share) return share;
    left -= length;
    pages -= 1;
  }
  return Number.POSITIVE_INFINITY; // every page fits whole
}

export class BatchGetDocumentsTool extends BaseTool<typeof InputSchema> {
  readonly name = 'read_docs_batch';
  readonly description =
    `Fetch up to ${LIMITS.maxBatchSize} Magic Lane documentation pages in a single call: at most ` +
    `${LIMITS.maxBatchSize} URLs are accepted, a longer array is refused with that limit, and one of ` +
    `${LIMITS.maxToolInputElements} values or more is refused outright, without naming it. ` +
    'Returns the markdown content of each page; pages that fail to load are reported ' +
    'individually, and the call is an error only when every page failed. The page text is ' +
    `capped at ${LIMITS.maxBatchChars} characters shared across the pages (headers and error notes come ` +
    'on top) — a page cut short says where to continue with read_doc.';
  readonly annotations: ToolAnnotations = {
    ...READ_ONLY_ANNOTATIONS,
    title: 'Get multiple Magic Lane documentation pages',
  };

  constructor() {
    super({ inputSchema: InputSchema });
  }

  async run(rawInput: unknown): Promise<CallToolResult> {
    const { urls } = rawInput as Input;
    // A page given twice, in any spelling, is fetched and returned once.
    const keys = urls.map(pageKey);
    const firstOf = keys.map((key) => keys.indexOf(key));
    const unique = urls.filter((_, i) => firstOf[i] === i);
    // The pages queue for outbound slots together: the later ones may wait
    // their turn longer than a single page would (see FETCH.batchTimeoutMs).
    const fetched = await withRequestContext({ batch: unique.length }, () =>
      Promise.allSettled(unique.map((u) => getDocument(u)))
    );
    const byUrl = new Map(unique.map((u, i) => [u, fetched[i] as PromiseSettledResult<FetchedDocument>]));
    const results = urls.map(
      (_, i) => byUrl.get(urls[firstOf[i] as number] as string) as PromiseSettledResult<FetchedDocument>
    );

    // Only pages that loaded share the budget, and a short page takes only
    // what it needs: the rest is shared evenly among the longer ones.
    const allowance = shareBudget(
      fetched.flatMap((r) => (r.status === 'fulfilled' ? [r.value.content.length] : [])),
      LIMITS.maxBatchChars
    );
    const parts = results.map((result, i) => {
      // A reference as given heads its document on one line: a line break in
      // it would end the heading (see quoteArgument).
      if (firstOf[i] !== i)
        return `# Document ${i + 1}: ${quoteArgument(urls[i] as string)}\n\nThe same page as document ${(firstOf[i] as number) + 1}.`;
      if (result.status === 'rejected') {
        return `# Document ${i + 1}: ${quoteArgument(urls[i] as string)}\n\nERROR: failed to fetch (${errorMessage(result.reason)})`;
      }
      const doc = result.value;
      const slice = sliceDocument(doc.content, 0, Math.max(MIN_CHARS_PER_PAGE, allowance));
      const note = slice.hasMore
        ? `\n\n(Showing the first ${slice.end} of ${slice.total} characters. ` +
          `Read the rest with read_doc, offset: ${slice.end}.)`
        : '';
      return `# Document ${i + 1}: ${doc.url}${note}\n\n${slice.text}`;
    });

    // Pages lost to load, not to the page itself: say which to ask for again.
    const retry = unique.filter((_, i) => {
      const r = fetched[i] as PromiseSettledResult<unknown>;
      return r.status === 'rejected' && isLoadFailure(r.reason);
    });
    const retryNote =
      retry.length > 0 && retry.length < fetched.length
        ? `\n\n---\n\n${retry.length} page(s) did not load in time (the site was slow to answer, or this server ` +
          `busy). Read them with another ` +
          `read_docs_batch call: ${JSON.stringify(retry)}`
        : '';
    const text = parts.join('\n\n---\n\n') + retryNote;
    const failures = fetched.filter((r) => r.status === 'rejected').length;
    return failures === fetched.length ? this.errorResponse(text) : this.textResponse(text);
  }
}
