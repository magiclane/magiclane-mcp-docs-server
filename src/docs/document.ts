/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Single-page reading: turning whatever reference the model hands us into the
 * one canonical `.md` URL on developer.magiclane.com, and fetching it.
 */

import { DOCS, LIMITS, isAllowedDocUrl } from '../config/constants.js';
import { fetchText } from '../utils/http-client.js';
import { webPageLinks } from '../utils/page-links.js';
import { stripAnchorArtifacts } from './markdown.js';

export interface FetchedDocument {
  /** Canonical URL the content was read from. */
  url: string;
  /** Pathname of that URL, e.g. /docs/flutter/examples/maps-3dscene/add-markers.md */
  path: string;
  /** The whole page, anchor artifacts removed. Callers slice; nothing is lost here. */
  content: string;
}

export interface DocRef {
  url: string;
  path: string;
}

/**
 * Normalize a user-supplied reference to the canonical documentation URL.
 * Accepted shapes, all reduced to `https://developer.magiclane.com/docs/<path>.md`:
 *
 *   /docs/flutter/examples/hello-map            (docs path, .md added)
 *   /flutter/examples/hello-map                 (source path without /docs)
 *   docs/flutter/examples/hello-map.MD          (relative, odd extension case)
 *   https://developer.magiclane.com/docs/...    (absolute, http:// upgraded)
 *   developer.magiclane.com/docs/...?from=search#section
 *
 * Query strings and fragments are dropped — the site serves markdown only at
 * the bare `.md` path. Anything on another host is refused.
 *
 * Spellings of one page collapse to one URL — one cache entry and at most one
 * fetch — so case, doubled slashes and percent-encoded letters cannot be used
 * to fetch the same page many times: every published docs path is lower-case.
 */
export function normalizeDocRef(ref: string): DocRef {
  let text = ref.trim();
  if (text.length === 0) throw new Error('Empty documentation reference');
  if (text.length > LIMITS.maxRefChars) {
    throw new Error(`Documentation reference is too long (${text.length} characters; limit ${LIMITS.maxRefChars})`);
  }

  // Windows-style separators are separators.
  text = text.replace(/\\/g, '/');
  if (text.startsWith('//')) text = `https:${text}`;
  else if (/^http:\/\//i.test(text)) {
    // Upgraded to https, the http default port goes too: ":80" would now name another port.
    text = `https://${text.slice('http://'.length)}`.replace(/^(https:\/\/[^/?#]*?):80(?=[/?#]|$)/i, '$1');
  } else if (!/^https:\/\//i.test(text)) {
    // No scheme: either the docs host spelled out, or a path. Any other scheme
    // (ftp:, file:, javascript:, …) is not a documentation reference at all.
    const bareHost = new RegExp(`^${DOCS.host.replace(/\./g, '\\.')}(?=[/?#:]|$)`, 'i');
    if (bareHost.test(text)) text = `https://${text}`;
    else if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
      throw new Error(
        `Only https://${DOCS.host} documentation URLs or /docs/... paths are supported; got a ` +
          `"${(text.match(/^[a-z][a-z0-9+.-]*:/i) as RegExpMatchArray)[0]}" reference.`
      );
    } else {
      if (!text.startsWith('/')) text = `/${text}`;
      if (!/^\/docs(?=\/|$)/i.test(text)) text = `/docs${text}`;
      text = `${DOCS.baseUrl}${text}`;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`Not a valid documentation URL or path: ${JSON.stringify(ref.trim().slice(0, 120))}`);
  }
  if (!isAllowedDocUrl(parsed.toString())) {
    if (parsed.hostname.toLowerCase() === DOCS.host) {
      throw new Error(
        parsed.username || parsed.password
          ? `Documentation URLs carry no credentials; use https://${DOCS.host}/docs/... without "user:password@".`
          : `Documentation URLs use the default https port; got port ${parsed.port} on ${DOCS.host}.`
      );
    }
    throw new Error(
      `Only https://${DOCS.host} documentation URLs are supported; got ${parsed.hostname}. ` +
        `Other providers' documentation is not applicable to Magic Lane — use ` +
        `search_docs to find the correct ${DOCS.host} page.`
    );
  }

  // Decode percent-encoded unreserved characters (%66 = f) and encoded
  // slashes (%2F, %5C: separators, as written out — so no spelling slips a
  // path past the checks below), fold case and doubled slashes; every
  // published path is lower-case with single slashes.
  let path = parsed.pathname
    .replace(/%([0-9a-f]{2})/gi, (escape: string, hex: string) => {
      const char = String.fromCharCode(parseInt(hex, 16));
      if (char === '/' || char === '\\') return '/';
      return /[a-z0-9._~-]/i.test(char) ? char : escape;
    })
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
  // Dot segments an encoded slash produced ("a/..%2Fb" is "a/../b" now) are
  // resolved as the site would, so the /docs check below sees the path the
  // fetch goes to — the URL parser resolved only the ones written out.
  const segments: string[] = [];
  for (const segment of path.split('/').slice(1)) {
    if (segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  path = `/${segments.join('/')}`;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (!/^\/docs(\/|$)/.test(path)) path = `/docs${path === '/' ? '' : path}`;
  // The site's HTML pages have markdown twins at the same path with .md.
  path = path.replace(/\.html?$/, '');
  if (!/\.(md|txt)$/.test(path)) path += '.md';
  if (path.endsWith('/llms-full.txt')) {
    throw new Error(
      'llms-full.txt is the whole documentation of a source (megabytes); use search_docs for excerpts ' +
        'and read_doc on the individual pages it lists.'
    );
  }

  return { url: `${DOCS.baseUrl}${path}`, path };
}

/** Fetch a single documentation page as markdown. */
export async function getDocument(ref: string): Promise<FetchedDocument> {
  const { url, path } = normalizeDocRef(ref);
  // Links as web pages before the text is measured: the totals and offsets
  // the tools report are those of the text they return.
  const content = webPageLinks(stripAnchorArtifacts(await fetchText(url)));
  return { url, path, content };
}

/** A slice of a page for one tool response, with the honest totals. */
export interface DocumentSlice {
  text: string;
  /** Characters of the whole page. */
  total: number;
  /** Where the slice starts and ends (exclusive). */
  start: number;
  end: number;
  /** Whether anything follows `end`. */
  hasMore: boolean;
}

/**
 * Cut `content` at character offsets without splitting a surrogate pair, and
 * report the real total so the caller can page to the end. Throws when the
 * offset lies beyond the page.
 */
export function sliceDocument(content: string, offset: number, maxChars: number): DocumentSlice {
  const total = content.length;
  if (offset > 0 && offset >= total) {
    throw new Error(`offset ${offset} is beyond the end of the page (${total} characters)`);
  }
  let start = offset;
  let end = Math.min(offset + maxChars, total);
  if (start > 0 && isLowSurrogate(content.charCodeAt(start))) start--;
  // Never end inside a surrogate pair: step back — or, when that would leave
  // nothing (maxChars 1 at an emoji), forward, so paging always advances.
  if (end < total && isLowSurrogate(content.charCodeAt(end))) end = end - 1 > start ? end - 1 : end + 1;
  return { text: content.slice(start, end), total, start, end, hasMore: end < total };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
