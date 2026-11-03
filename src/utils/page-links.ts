/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Page links as the web pages people open. Shared by the tools' responses
 * (tools/base-tool.ts) and the page text (docs/document.ts), which gets its
 * links rewritten before it is measured and sliced, so the character counts
 * and offsets a tool reports are those of the text it returns.
 */
import { DOCS } from '../config/constants.js';

/**
 * A documentation page's .md address (its markdown, which the tools read),
 * http or https, .md in any case, followed by what ends a link: whitespace,
 * closing brackets or quotes, bold or italic marks, a table pipe, an anchor
 * or query, sentence punctuation, or the end of the text. The path may hold
 * "_" (two pages do: …/map_update, …/search_category) or "*": the shortest
 * match ends at the first ".md" one of those marks follows, so bold and
 * italic marks around the link still stay outside it. Not one named as what
 * a fetch failed "for": an error names the address that was actually fetched.
 */
const MARKDOWN_PAGE = new RegExp(
  `(?<!\\bfor )https?://${DOCS.host.replace(/[.]/g, '\\.')}(/docs/[^\\s()<>\\[\\]"'\`|]*?)\\.md(?=[\\s)\\]"'>\`#?.,;:!*_|]|$)`,
  'gi'
);

/** A relative link to a page's .md address inside page text: `](/docs/flutter/x.md#part)`. */
const RELATIVE_MARKDOWN_LINK = /\]\((\/docs\/[^\s()<>"']*?)\.md((?:#[^\s()<>"']*)?)\)/gi;

/**
 * Page links as the web pages people open: https://developer.magiclane.com/docs/guides/get-started,
 * not its markdown twin …/get-started.md — whether a tool wrote the link or the page text holds
 * it, absolute or relative. Models copy the links they are given into their answers, so the tools
 * give the readable ones; every tool still takes either form.
 */
export function webPageLinks(text: string): string {
  return text
    .replace(MARKDOWN_PAGE, (_match, path: string) => `${DOCS.baseUrl}${path}`)
    .replace(RELATIVE_MARKDOWN_LINK, (_match, path: string, anchor: string) => `](${DOCS.baseUrl}${path}${anchor})`);
}

/**
 * Structured content with every page link in it, at any depth, as a web page
 * link (see webPageLinks): the `url` fields, and the links inside excerpt
 * text. A page's `path` is not a link and stays as it is.
 */
export function webPageUrls(value: unknown): unknown {
  if (typeof value === 'string') return webPageLinks(value);
  if (Array.isArray(value)) return value.map((v) => webPageUrls(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, webPageUrls(v)]));
  }
  return value;
}
