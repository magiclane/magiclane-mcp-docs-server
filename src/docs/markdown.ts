/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Small markdown utilities shared by the page splitter and the code-example
 * extractor, so both agree on what a code block and a heading are.
 */

/**
 * Docusaurus emits an invisible self-link after every heading —
 * `Heading[<U+200B>](#heading "Direct link to Heading")` — which is 4–5% of the bytes
 * of a page and pure noise to a model. Strip the link, keep the heading.
 */
export function stripAnchorArtifacts(markdown: string): string {
  // The quoted title may itself hold parentheses and escaped quotes:
  // "Direct link to BLE server (BLEServer)", "Direct link to AI agents are \"lost\"".
  return markdown.replace(/\[\u200b?\]\(#[^)\s]*(?:\s+"(?:[^"\\\n]|\\.)*")?\)/g, '');
}

export interface MarkdownLine {
  text: string;
  /**
   * True for the fence markers themselves and every line between them, and
   * for every line of an indented code block.
   */
  inFence: boolean;
  /**
   * Set on the opening line of a code block: a fence's info string and
   * indentation (the characters removed from each line of the code) — or,
   * for an indented code block, `indented` with no language and the
   * indentation of its code (four columns beyond its list item, if any);
   * there the opening line is code itself.
   */
  opens?: { language: string; indent: number; indented?: true };
  /**
   * Set on the closing fence line — and on the first line after a block that
   * ends it otherwise, which is not part of the block and may open another:
   * the line that leaves the blockquote a fence was in, the first line
   * indented less than the list item a fence is in, or the first line
   * indented less than an indented code block.
   */
  closes?: boolean;
  /** For a fence inside a blockquote: the line without its `>` marker. */
  content?: string;
  /**
   * Set on a heading line outside a code block: an ATX heading ("## Title",
   * indented at most three columns, closing #s removed) or the underline of a
   * setext heading ("=" for level 1, "-" for level 2 under a paragraph, whose
   * text is the heading).
   */
  heading?: { level: number; text: string };
}

/** A blockquote marker at the start of a line. */
const QUOTE = /^ {0,3}>[ ]?/;
/** A fence: three or more backticks or tildes, after any indentation, with its info string. */
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
/** A list item marker, with the spaces or tabs before its content (none when the line holds nothing else). */
const LIST_ITEM = /^([-*+]|\d{1,9}[.)])(?:([ \t]+)(?=\S)|[ \t]*$)/;
/** An ATX heading, with its text (closing #s still on it). */
const ATX = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
/** A setext underline: a run of "=" or "-" alone on its line. */
const SETEXT = /^(=+|-+)[ \t]*$/;
/** A thematic break: three or more "*", "-" or "_", spaces between them. */
const THEMATIC = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/**
 * Classify each line of a document as CommonMark does. Fences use ``` or ~~~
 * of any length (three or more), may be indented up to three columns beyond
 * the list item they are in, or stand inside a blockquote, and close only on a
 * fence of the same character at least as long with nothing after it, indented
 * at most three columns beyond the item — or where the item or blockquote
 * ends: at the first line indented less than the item (a closer there still
 * closes the fence, where CommonMark would open another), or outside the
 * quote. A backtick fence's info string holds no backtick (that line is inline
 * code, not a fence). A line indented four columns or more beyond its list
 * item, after a blank line, starts an indented code block, which runs to the
 * first line indented less (a line so indented right after a paragraph line
 * continues the paragraph instead). An unterminated block runs to the end of
 * the document. Headings are marked too: ATX headings ("## Title", up to
 * three columns in, closing #s dropped) and setext headings (a paragraph
 * underlined with "=" or "-"). List items are tracked for their indentation
 * only: a nested item four columns in is an item, not code.
 */
export function scanMarkdown(markdown: string): MarkdownLine[] {
  const out: MarkdownLine[] = [];
  // The open fence: its character and length, whether it is in a blockquote,
  // and the content indent of the list item it is in.
  let fence: { char: string; length: number; quoted: boolean; base: number } | null = null;
  // The open indented code block: the content indent of the list item it is in.
  let indented: { base: number } | null = null;
  // The content indents (in columns) of the open list items, outermost first.
  const items: number[] = [];
  // The lines of the paragraph right above: what a setext underline heads,
  // and what a line indented less than its list item continues lazily.
  let paragraph: string[] = [];
  for (const text of markdown.split('\n')) {
    const quote = QUOTE.exec(text)?.[0];
    let ended = false;
    if (fence?.quoted && quote === undefined) {
      fence = null; // the blockquote ended, and the fence with it
      ended = true;
    } else if (
      fence &&
      text.trim() !== '' &&
      indentColumns(text) < fence.base &&
      !closesFence(FENCE.exec(text), fence)
    ) {
      // A line indented less than the list item the fence is in ends the
      // item, and the fence with it: code has no lazy lines. Only the fence's
      // own closer is still taken for one there.
      fence = null;
      ended = true;
    }
    const quoted: boolean = fence ? fence.quoted : quote !== undefined;
    const body: string = quoted ? text.slice((quote as string).length) : text;
    const m = FENCE.exec(body);
    const extra = quoted ? { content: body } : {};
    if (fence) {
      const closes = closesFence(m, fence) && indentColumns(body) - fence.base <= 3;
      out.push({ text, inFence: true, ...(closes ? { closes: true } : {}), ...extra });
      if (closes) fence = null;
      continue;
    }
    const blank = text.trim() === '';
    if (indented) {
      if (blank || indentColumns(text) >= indented.base + 4) {
        out.push({ text, inFence: true });
        continue;
      }
      indented = null; // this line is not part of the block, and is read on
      ended = true;
    }
    const ends = ended ? { closes: true } : {};
    if (blank) {
      paragraph = [];
      out.push({ text, inFence: false, ...ends });
      continue;
    }
    if (quoted) {
      // Inside a blockquote only fences are told apart, at any indentation.
      if (m && !isInlineCode(m)) {
        fence = { char: (m[2] as string)[0] as string, length: (m[2] as string).length, quoted: true, base: 0 };
        out.push({ text, inFence: true, opens: openerOf(m), ...ends, ...extra });
        continue;
      }
      paragraph = [];
      out.push({ text, inFence: false, ...ends });
      continue;
    }
    const columns = indentColumns(text);
    const trimmed = text.trimStart();
    const marker = LIST_ITEM.exec(trimmed);
    // A line indented less than the list item's content continues the
    // paragraph it is in lazily, unless it starts a block of its own; any
    // other such line ends the items it is not in.
    const lazy =
      paragraph.length > 0 &&
      columns < (items[items.length - 1] ?? 0) &&
      marker === null &&
      m === null &&
      !ATX.test(trimmed) &&
      !SETEXT.test(trimmed) &&
      !THEMATIC.test(trimmed);
    if (!lazy) {
      const open = items.length;
      while (items.length > 0 && columns < (items[items.length - 1] as number)) items.pop();
      if (items.length < open) paragraph = []; // the paragraph was an ended item's
    }
    const base = items[items.length - 1] ?? 0;
    if (columns - base >= 4) {
      if (paragraph.length > 0) {
        // Indented code cannot interrupt a paragraph: this line continues it.
        paragraph.push(trimmed);
        out.push({ text, inFence: false, ...ends });
        continue;
      }
      indented = { base };
      out.push({
        text,
        inFence: true,
        opens: { language: '', indent: indentChars(text, base + 4), indented: true },
        ...ends,
      });
      continue;
    }
    if (m && !isInlineCode(m)) {
      fence = { char: (m[2] as string)[0] as string, length: (m[2] as string).length, quoted: false, base };
      paragraph = [];
      out.push({ text, inFence: true, opens: openerOf(m), ...ends });
      continue;
    }
    if (SETEXT.test(trimmed) && paragraph.length > 0) {
      const heading = { level: trimmed.startsWith('=') ? 1 : 2, text: paragraph.join(' ') };
      paragraph = [];
      out.push({ text, inFence: false, ...ends, heading });
      continue;
    }
    if (THEMATIC.test(trimmed)) {
      paragraph = [];
      out.push({ text, inFence: false, ...ends });
      continue;
    }
    if (marker) {
      // A list item starts: its content begins after the marker and the gap
      // that follows it, in columns (a tab reaches the next tab stop) — one
      // column when the line holds nothing else, or when the gap is five or
      // more (the content is then indented code of the item).
      const markerEnd = columns + (marker[1] as string).length;
      const gap = marker[2] ?? '';
      let width = 0;
      for (const char of gap) width += char === '\t' ? 4 - ((markerEnd + width) % 4) : 1;
      items.push(markerEnd + (gap === '' || width > 4 ? 1 : width));
      const rest = trimmed.slice((marker[1] as string).length + gap.length);
      paragraph = rest === '' ? [] : [rest];
      out.push({ text, inFence: false, ...ends });
      continue;
    }
    const atx = ATX.exec(trimmed);
    if (atx) {
      paragraph = [];
      const heading = withoutClosingHashes(atx[2] ?? '');
      out.push({
        text,
        inFence: false,
        ...ends,
        ...(heading === '' ? {} : { heading: { level: (atx[1] as string).length, text: heading } }),
      });
      continue;
    }
    paragraph.push(trimmed);
    out.push({ text, inFence: false, ...ends });
  }
  return out;
}

/** Whether a fence line can close `fence`: the same character, at least as long, nothing after it. */
function closesFence(m: RegExpExecArray | null, fence: { char: string; length: number }): boolean {
  return (
    m !== null &&
    (m[2] as string)[0] === fence.char &&
    (m[2] as string).length >= fence.length &&
    (m[3] as string).trim() === ''
  );
}

/** A backtick fence whose info string holds a backtick is inline code ("```js` is how…"), not a fence. */
function isInlineCode(m: RegExpExecArray): boolean {
  return (m[2] as string)[0] === '`' && (m[3] as string).includes('`');
}

/** What a fence opens: the first word of its info string, and its indentation in characters. */
function openerOf(m: RegExpExecArray): { language: string; indent: number } {
  return { language: (m[3] as string).trim().split(/\s+/)[0] as string, indent: (m[1] as string).length };
}

/** An ATX heading's text without its closing #s ("Example ##" → "Example"; "C#" keeps its #). */
function withoutClosingHashes(text: string): string {
  return text.replace(/(?:^|[ \t]+)#+[ \t]*$/, '');
}

/** The width in columns of a line's leading spaces and tabs (a tab reaches the next multiple of four). */
function indentColumns(text: string): number {
  let columns = 0;
  for (const char of text) {
    if (char === ' ') columns += 1;
    else if (char === '\t') columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

/** How many leading characters of `text`, which is indented at least that far, make up `columns` columns. */
function indentChars(text: string, columns: number): number {
  let width = 0;
  let chars = 0;
  while (width < columns) {
    width += text[chars] === '\t' ? 4 - (width % 4) : 1;
    chars++;
  }
  return chars;
}
