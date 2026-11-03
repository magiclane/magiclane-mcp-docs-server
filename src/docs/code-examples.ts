/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Extraction of code blocks, fenced or indented, from documentation pages.
 */

import { DOCS } from '../config/constants.js';
import { scanMarkdown, stripAnchorArtifacts } from './markdown.js';
import type { MarkdownLine } from './markdown.js';

export interface CodeBlock {
  /** Language tag of the fence (lowercased), or 'text' when there is none: a fence without one, or an indented block. */
  language: string;
  /** The code inside the fence, without the fence markers or the fence's indentation. */
  code: string;
  /** Nearest markdown heading above the block, when one exists. */
  heading?: string;
  /**
   * The line that introduces the block, when there is one right above it:
   * "Request Body", "Response Body (error code 200)", "Create Configuration:
   * Define a ConfigurationParameters object…". Markdown markers are removed.
   */
  caption?: string;
}

/**
 * Headings that say nothing on their own ("Example:" under "Step 5: Create the
 * Optimization"): the block is labelled with the heading above them too.
 */
const GENERIC_HEADINGS = new Set(['example', 'examples', 'sample', 'samples', 'code', 'usage', 'request', 'response']);

/** The heading for a block: the nearest one, qualified by its parent when it is generic. */
function headingOf(trail: Array<{ level: number; text: string }>): string | undefined {
  const nearest = trail[trail.length - 1];
  if (!nearest) return undefined;
  const parent = trail.length > 1 ? trail[trail.length - 2] : undefined;
  return parent && GENERIC_HEADINGS.has(nearest.text.toLowerCase()) ? `${parent.text} › ${nearest.text}` : nearest.text;
}

/**
 * The longest line, as the page wrote it (see SITE_PAGE_LINK), still taken
 * for a caption rather than prose.
 */
const MAX_CAPTION_CHARS = 120;

/**
 * The start of a link to one of the site's own pages as the page text holds
 * it once its links are rewritten as web pages (utils/page-links.ts), which
 * happens before the blocks are extracted: "](https://developer.magiclane.com/docs/…".
 * The page wrote such a link by its path, "](/docs/…", 31 characters shorter.
 */
const SITE_PAGE_LINK = new RegExp(`\\]\\(${DOCS.baseUrl.replace(/[.]/g, '\\.')}(?=/docs/)`, 'g');

/**
 * The caption of a block: the last non-blank line before its fence, when it
 * is written as a label — a list item, a bold run, or a line ending in a
 * colon — rather than a heading, a bare link, a table row or plain prose.
 */
function captionOf(line: string | undefined): string | undefined {
  if (line === undefined) return undefined;
  let text = stripAnchorArtifacts(line).trim();
  const listed = /^(?:[-*+]|\d+[.)])\s+/.test(text);
  text = text.replace(/^(?:[-*+]|\d+[.)])\s+/, '');
  if (text === '' || /^(#|\||\[.*\]\(.*\)$)/.test(text)) return undefined;
  if (!listed && !/\*\*|__/.test(text) && !/:$/.test(text)) return undefined;
  text = text
    .replace(/\*\*|__/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/:(?=\s*\()/, '') // "Response Body: (error code 200)"
    .replace(/\s*:\s*$/, '')
    .trim();
  // Measured as the page wrote the line: a link to one of the site's pages
  // counts by its path, so rewriting it as a web page makes no label prose.
  const asWritten = text.replace(SITE_PAGE_LINK, '](');
  return asWritten.length > 0 && asWritten.length <= MAX_CAPTION_CHARS ? text : undefined;
}

/**
 * Whether a list item is written as the label of what follows it ("* **Request
 * Body:**", "* **Response Body:** (code `200 OK`)", "2. Replace the token
 * placeholder with your actual token:") rather than as one more item of the
 * page's own list ("- the error code", "3. Save the file."): it ends in a
 * colon, inside or after its bold or italic marks, with at most a remark in
 * parentheses after it.
 */
function isLabelItem(line: string | undefined): boolean {
  return line !== undefined && /:[*_]{0,3}(?:\s*\([^()]*\))?$/.test(line.trim());
}

/**
 * A short list item, as Docusaurus exports a tab label ("* Kotlin", "* Java"):
 * its text, or undefined. A label names a language or a platform: a word or
 * two, no colon, no code — "* **Request Body:**" and "* `Accept: …`" are a
 * page's own list items.
 */
function tabLabel(line: string): string | undefined {
  const m = /^\s*[-*+]\s+(.{1,40})$/.exec(line);
  const text = m?.[1]?.trim().replace(/\*\*|__/g, '');
  return text !== undefined && !/[.:;,`]/.test(text) ? text : undefined;
}

/**
 * How many fences follow in a row from `from`, with nothing but blank lines
 * between them: a tab group is N labels, then exactly N such fences.
 */
function fencesInARow(lines: readonly MarkdownLine[], from: number): number {
  let count = 0;
  let inside = false;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i] as MarkdownLine;
    if (inside) {
      if (!line.closes) continue;
      inside = false;
      if (line.inFence) continue; // a closing fence; a line that ends a block otherwise is read on
    }
    if (line.opens) {
      count += 1;
      inside = true;
    } else if (line.text.trim() !== '') break;
  }
  return count;
}

/**
 * Extract all code blocks from a markdown document: fenced blocks, which may
 * be indented (inside list items) — the indentation is removed from the code —
 * and indented code blocks (four columns beyond their list item, tagged 'text').
 * A `#` line inside a block (a shell comment) is never taken for a heading.
 */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  // Headings above the current line, shallowest first (a new heading drops the deeper ones).
  const trail: Array<{ level: number; text: string }> = [];
  let previous: string | undefined; // the last non-blank line outside a fence
  // A Docusaurus tab group is exported as its labels ("* Kotlin", "* Java")
  // followed by one fence per tab: block k is labelled with label k, not
  // with the last label above them all.
  let labels: string[] = []; // the short list items right above (a tab group's labels, maybe)
  let listRun = 0; // how many list items in a row end just above (a page's own list, past one)
  let tabs: string[] = []; // the labels still due to the next fences of a tab group
  let open: { language: string; indent: number; lines: string[]; caption?: string } | null = null;
  const push = (): void => {
    if (!open) return;
    const code = open.lines.join('\n').replace(/\s+$/, '');
    if (code.length > 0) {
      blocks.push({
        language: open.language,
        code,
        heading: headingOf(trail),
        ...(open.caption !== undefined ? { caption: open.caption } : {}),
      });
    }
  };

  const lines = scanMarkdown(markdown);
  for (const [n, line] of lines.entries()) {
    if (open) {
      if (!line.closes) {
        open.lines.push(dedent(line.content ?? line.text, open.indent));
        continue;
      }
      push();
      open = null;
      previous = undefined; // a block is not the caption of the next one
      labels = [];
      listRun = 0;
      // A closing fence is done with; a line that ended a quoted fence by
      // leaving the quote is read like any other line.
      if (line.inFence && !line.opens) continue;
    }
    if (line.opens) {
      if (labels.length >= 2 && fencesInARow(lines, n) === labels.length) tabs = labels;
      // The last item of a page's own list ("- the error code / - the items")
      // is no caption: a list item captions a block when it stands alone, or
      // when it is written as a label ("* **Request Body:**" after the
      // endpoint and headers items, "2. Replace the token placeholder:").
      const ownList = listRun >= 2 && !isLabelItem(previous);
      const caption = tabs.length > 0 ? tabs.shift() : ownList ? undefined : captionOf(previous);
      labels = [];
      listRun = 0;
      open = {
        language: line.opens.language.toLowerCase() || 'text',
        indent: line.opens.indent,
        lines: [],
        caption,
      };
      // An indented code block's first line is code itself; a fence's opening line is only the fence.
      if (line.opens.indented) open.lines.push(dedent(line.text, open.indent));
      continue;
    }
    if (line.text.trim() !== '') {
      // Anything but another fence ends a tab group; a run of short list
      // items may start one.
      tabs = [];
      const label = tabLabel(line.text);
      labels = label === undefined ? [] : [...labels, label];
      listRun = /^\s*(?:[-*+]|\d+[.)])\s+/.test(line.text) ? listRun + 1 : 0;
    }
    if (line.heading) {
      const { level } = line.heading;
      while (trail.length > 0 && (trail[trail.length - 1] as { level: number }).level >= level) trail.pop();
      trail.push({ level, text: stripAnchorArtifacts(line.heading.text).trim().replace(/:$/, '') });
    }
    if (line.text.trim() !== '') previous = line.text;
  }
  // Unterminated fence: keep what was collected rather than dropping it.
  push();
  return blocks;
}

/** Remove up to `indent` leading spaces or tabs, the fence's own indentation. */
function dedent(line: string, indent: number): string {
  let i = 0;
  while (i < indent && i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return line.slice(i);
}

/** Keep the blocks whose caption contains `text` (case-insensitive); a blank filter keeps every block. */
export function filterByCaption(blocks: CodeBlock[], text?: string): CodeBlock[] {
  const wanted = text?.trim().toLowerCase() ?? '';
  if (wanted === '') return blocks;
  return blocks.filter((b) => b.caption?.toLowerCase().includes(wanted));
}

/**
 * Filter blocks by language tag, case-insensitively, honouring common
 * aliases (ts/typescript, js/javascript, kt/kotlin, c++/cpp, yml/yaml,
 * sh/bash/shell).
 */
export function filterByLanguage(blocks: CodeBlock[], language?: string): CodeBlock[] {
  if (!language?.trim()) return blocks;
  const wanted = languageKey(language);
  return blocks.filter((b) => languageKey(b.language) === wanted);
}

const ALIASES: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  ts: 'typescript',
  js: 'javascript',
  kt: 'kotlin',
  'c++': 'cpp',
  'objective-c': 'objc',
  yml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  console: 'shell',
});

/** A language tag as the filter compares it: trimmed, lowercased, aliases folded ("ts" → "typescript"). */
export function languageKey(language: string): string {
  const normalized = language.trim().toLowerCase();
  return ALIASES[normalized] ?? normalized;
}

/** One block, or one part of a block too long to return in one response. */
export interface CodePart extends CodeBlock {
  /** Index of the block on the page (0-based). */
  block: number;
  /** Which part of the block this is (1-based), and how many there are. */
  part: number;
  parts: number;
  /** True when this part ends in the middle of a line, which the next part continues. */
  midLine: boolean;
}

/**
 * Split every block longer than `size` characters into parts of at most
 * `size`, at line breaks where possible — blank lines included, so the parts
 * joined with "\n" give the block back exactly — and inside a line only when
 * the line alone is longer than a part (never inside a surrogate pair).
 * Shorter blocks pass through as one part.
 */
export function splitLongBlocks(blocks: CodeBlock[], size: number): CodePart[] {
  return blocks.flatMap((b, block) => {
    const pieces = splitCode(b.code, size);
    return pieces.map((piece, i) => ({ ...b, ...piece, block, part: i + 1, parts: pieces.length }));
  });
}

function splitCode(code: string, size: number): Array<{ code: string; midLine: boolean }> {
  if (code.length <= size) return [{ code, midLine: false }];
  const pieces: Array<{ code: string; midLine: boolean }> = [];
  let current: string | undefined; // undefined: no line has started in this piece yet
  for (const line of code.split('\n')) {
    let rest = line;
    while (rest.length > size) {
      if (current !== undefined) pieces.push({ code: current, midLine: false });
      current = undefined;
      const high = rest.charCodeAt(size - 1);
      const cut = high >= 0xd800 && high <= 0xdbff ? size - 1 : size;
      pieces.push({ code: rest.slice(0, cut), midLine: true });
      rest = rest.slice(cut);
    }
    const candidate = current === undefined ? rest : `${current}\n${rest}`;
    if (candidate.length > size && current !== undefined) {
      pieces.push({ code: current, midLine: false });
      current = rest;
    } else {
      current = candidate;
    }
  }
  // The last line always leaves a piece open.
  pieces.push({ code: current as string, midLine: false });
  return pieces;
}
