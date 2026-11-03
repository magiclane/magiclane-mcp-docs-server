// SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
// SPDX-License-Identifier: Apache-2.0
//
// Whether CHANGELOG.md is ready for the release of a version. Entries wait
// under "## [Unreleased]", undated, and get "## [<version>] — <date>" on the
// release day: a date written ahead of it goes stale as commits keep coming
// (1.0.0 was dated two weeks before it could be released). So the release of
// a version needs its entry dated the release day, and nothing left waiting:
// an HTML comment or a link definition under a heading is no entry, so an
// empty "## [Unreleased]" kept above the new version's entry passes.
// Read by scripts/release.js before anything runs, and by test/changelog.test.ts.

/** A section heading as Keep a Changelog writes it: `## [1.0.0] — 2026-10-06` (em dash, en dash or hyphen), or `## [Unreleased]`. */
const HEADING = /^## \[([^\]]+)\](?:\s+[—–-]\s+(\S+))?\s*$/;

/** A Markdown link reference definition, such as Keep a Changelog's `[1.0.0]: https://…` lines at the end. */
const LINK_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*\S/;

/**
 * @typedef {object} Section
 * @property {string} version "Unreleased", or the version
 * @property {string | undefined} date the date after the dash, as written; undefined when the heading has none
 * @property {boolean} hasEntries whether any text follows the heading before the next one, comments and link definitions aside
 */

/**
 * The `## [...]` sections of a changelog, in order. HTML comments are read
 * as nothing at all, so a heading inside one is none either.
 * @param {string} changelog
 * @returns {Section[]}
 */
export function changelogSections(changelog) {
  /** @type {Section[]} */
  const sections = [];
  /** @type {Section | undefined} */
  let current;
  for (const line of changelog.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      const heading = HEADING.exec(line);
      current = heading ? { version: heading[1], date: heading[2], hasEntries: false } : undefined;
      if (current) sections.push(current);
    } else if (current && line.trim() !== '' && !LINK_DEFINITION.test(line)) {
      current.hasEntries = true;
    }
  }
  return sections;
}

/**
 * Why the changelog is not ready for the release of `version` on `today`
 * (YYYY-MM-DD), or undefined when it is: the version's entry is dated today,
 * and no entry waits under "Unreleased".
 * @param {string} changelog
 * @param {string} version
 * @param {string} today
 * @returns {string | undefined}
 */
export function changelogProblem(changelog, version, today) {
  const sections = changelogSections(changelog);
  const heading = `## [${version}] — ${today}`;
  if (sections.some((s) => s.version.toLowerCase() === 'unreleased' && s.hasEntries)) {
    return `CHANGELOG.md still has entries under ## [Unreleased]: move them under \`${heading}\` (the release day sets the date) first.`;
  }
  const entry = sections.find((s) => s.version === version);
  if (!entry) return `CHANGELOG.md has no entry for ${version}: add \`${heading}\` with this release's changes first.`;
  if (entry.date !== today) {
    const dated = entry.date === undefined ? 'has no date' : `is dated ${entry.date}`;
    return `CHANGELOG.md's entry for ${version} ${dated}, but the release day is ${today}: make its heading \`${heading}\` first.`;
  }
  return undefined;
}

/**
 * A moment as the calendar day of the local time zone, YYYY-MM-DD: the
 * release day as its maker reads it.
 * @param {Date} [now]
 * @returns {string}
 */
export function localDate(now = new Date()) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
