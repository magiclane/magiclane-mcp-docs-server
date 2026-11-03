/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { cutBetweenCharacters, quoteArgument } from './quote.js';

/**
 * The message of an unknown throw, for tool error texts. A network failure
 * says why ("fetch failed (ECONNREFUSED)"), not just that it failed: fetch
 * keeps the reason in the error's cause.
 */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as { code?: unknown; message?: unknown } | undefined;
  if (err.message !== 'fetch failed' || cause === undefined || cause === null) return err.message;
  const why = typeof cause.code === 'string' ? cause.code : typeof cause.message === 'string' ? cause.message : '';
  return why ? `fetch failed (${why})` : err.message;
}

/** The most a log line quotes of an error, and the most a protocol error's whole log line holds. */
const MAX_LOG_LINE = 300;

/** A zod issue, v3 or v4: a union's branches are nested in `errors` (v4) or `unionErrors` (v3). */
interface Issue {
  code?: unknown;
  path?: unknown;
  message?: unknown;
  errors?: unknown;
  unionErrors?: unknown;
}

/**
 * An error as one log line: a schema error (zod) as its issues, "path:
 * message" separated by "; ", not the pretty-printed list its message holds
 * (one bad message would otherwise take over a hundred lines); any line
 * breaks folded; and no longer than MAX_LOG_LINE characters (see capLine:
 * the issues may quote the client's own key names, emoji and all). A union
 * is checked against each of its shapes (the SDK checks a message against
 * request, notification, response and error) and reports one issue that
 * says only "Invalid input", with the shapes' own issues nested: the line
 * gives those of the closest shape, the one with the fewest.
 */
export function errorLine(err: unknown): string {
  const issues = (err as { issues?: unknown } | null)?.issues;
  const text = Array.isArray(issues)
    ? (issues as Issue[]).flatMap(closest).map(describeIssue).join('; ')
    : errorMessage(err);
  return capLine(text.replace(/\s*\n\s*/g, ' ').trim());
}

/** `line` cut to MAX_LOG_LINE characters, the last an ellipsis, between characters: never a lone surrogate. */
function capLine(line: string): string {
  return line.length > MAX_LOG_LINE ? `${cutBetweenCharacters(line, MAX_LOG_LINE - 1)}…` : line;
}

/**
 * The issue itself — or, for a union, the issues of its closest branch (the
 * first of the shortest). A zod v4 branch gives its issues' paths relative to
 * the union, so they are put at the union's own path; a v3 branch gives them
 * whole.
 */
function closest(issue: Issue): Issue[] {
  if (issue.code !== 'invalid_union') return [issue];
  if (Array.isArray(issue.errors) && issue.errors.length > 0) {
    const at = Array.isArray(issue.path) ? issue.path : [];
    return shortest(issue.errors as Issue[][])
      .flatMap(closest)
      .map((inner) => ({ ...inner, path: [...at, ...(Array.isArray(inner.path) ? inner.path : [])] }));
  }
  if (Array.isArray(issue.unionErrors) && issue.unionErrors.length > 0) {
    return shortest((issue.unionErrors as Array<{ issues: Issue[] }>).map((e) => e.issues)).flatMap(closest);
  }
  return [issue];
}

/** The first of the branches with the fewest issues. */
function shortest(branches: Issue[][]): Issue[] {
  return branches.reduce((best, branch) => (branch.length < best.length ? branch : best));
}

function describeIssue(issue: Issue): string {
  const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
  return path ? `${path}: ${String(issue.message)}` : String(issue.message);
}

/**
 * " (method m, id i)" naming what a message had of the two, for the log
 * line about a message the protocol rejected; "" when it had neither usable.
 * Both are the client's own text, so each is quoted on one line and cut
 * short (see quoteArgument): a line break in a method cannot start a log
 * line of its own, and a megabyte of method or id makes no megabyte of log.
 */
export function messageLabel(message: unknown): string {
  if (typeof message !== 'object' || message === null) return '';
  const { method, id } = message as { method?: unknown; id?: unknown };
  const parts: string[] = [];
  if (typeof method === 'string') parts.push(`method ${quoteArgument(method)}`);
  if (typeof id === 'string' || typeof id === 'number') parts.push(`id ${quoteArgument(JSON.stringify(id))}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/**
 * The stderr line about an error of the protocol: a message it rejected
 * (`message`, when there is one: see messageLabel) or one it reported, "MCP
 * protocol error (method m, id i): what was wrong", on one line of at most
 * MAX_LOG_LINE characters in all (see capLine).
 */
export function protocolErrorLine(err: unknown, message?: unknown): string {
  return capLine(`MCP protocol error${messageLabel(message)}: ${errorLine(err)}`);
}
