/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Arguments as a tool's text quotes them back. Models write these arguments
 * themselves, so what is at stake is confusion, or an injection relayed from
 * a page: a reply must not take an argument's lines for its own.
 */

/** The most a reply quotes of an argument: as normalizeDocRef quotes an unusable reference. */
export const MAX_QUOTED_CHARS = 120;

/**
 * An argument as a reply quotes it ("No documentation pages matched
 * "<query>"", "# Document 2: <reference>"): on one line, so a line break in
 * it cannot start a heading, a list item or a block of the reply's own, and
 * no longer than MAX_QUOTED_CHARS, cut between characters so an emoji at the
 * cut is never halved into a lone surrogate.
 */
export function quoteArgument(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= MAX_QUOTED_CHARS) return oneLine;
  return `${cutBetweenCharacters(oneLine, MAX_QUOTED_CHARS)}…`;
}

/**
 * The first `max` UTF-16 units of `text`, or one fewer where the cut would
 * halve a surrogate pair: an emoji at the cut is left out whole, never kept
 * as a lone surrogate.
 */
export function cutBetweenCharacters(text: string, max: number): string {
  return text.slice(0, isLowSurrogate(text.charCodeAt(max)) ? max - 1 : max);
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
