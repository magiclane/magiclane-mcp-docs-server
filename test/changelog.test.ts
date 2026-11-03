/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The CHANGELOG check of `npm run release` (scripts/changelog.mjs): the
 * release of a version needs its entry dated the release day, and nothing
 * left under "Unreleased", where entries wait undated until that day. And
 * this checkout's own CHANGELOG.md is in one of the two states the check
 * reads: the package version released on a day, or waiting.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { changelogProblem, changelogSections, localDate } from '../scripts/changelog.mjs';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json')) as { version: string };

const TODAY = '2026-10-20';
const changelog = (sections: string): string => `# Changelog\n\nAll notable changes.\n\n${sections}`;
const released = (version: string, date: string): string => `## [${version}] — ${date}\n\n### Added\n\n- A tool.\n\n`;

describe('changelogProblem', () => {
  it('accepts an entry for the version dated today, with an empty Unreleased section or none', () => {
    expect(changelogProblem(changelog(released('1.0.0', TODAY)), '1.0.0', TODAY)).toBeUndefined();
    expect(
      changelogProblem(changelog(`## [Unreleased]\n\n${released('1.0.0', TODAY)}`), '1.0.0', TODAY)
    ).toBeUndefined();
    // Earlier versions keep their own days.
    const two = changelog(released('1.1.0', TODAY) + released('1.0.0', '2026-10-06'));
    expect(changelogProblem(two, '1.1.0', TODAY)).toBeUndefined();
  });

  it('refuses while entries wait under Unreleased, even beside an entry dated today', () => {
    const waiting =
      'CHANGELOG.md still has entries under ## [Unreleased]: move them under `## [1.1.0] — 2026-10-20` (the release day sets the date) first.';
    expect(
      changelogProblem(changelog(`## [Unreleased]\n\n- A fix.\n\n${released('1.0.0', '2026-10-06')}`), '1.1.0', TODAY)
    ).toBe(waiting);
    expect(changelogProblem(changelog(`## [unreleased]\n\nText.\n\n${released('1.1.0', TODAY)}`), '1.1.0', TODAY)).toBe(
      waiting
    );
  });

  it('reads an HTML comment or a link definition under a heading as no entry, but text beside a comment as one', () => {
    const notes =
      '<!-- Changes wait here. -->\n\n<!--\nA longer note.\n-->\n\n[unreleased]: https://example.invalid/compare\n\n';
    const kept = changelog(
      `## [Unreleased]\n\n${notes}${released('1.0.0', TODAY)}[1.0.0]: https://example.invalid/1.0.0\n`
    );
    expect(changelogProblem(kept, '1.0.0', TODAY)).toBeUndefined();
    const fix = changelog(`## [Unreleased]\n\n- A fix. <!-- the why -->\n\n${released('1.0.0', TODAY)}`);
    expect(changelogProblem(fix, '1.0.0', TODAY)).toContain('still has entries under ## [Unreleased]');
  });

  it('refuses a version with no entry', () => {
    expect(changelogProblem(changelog(released('1.0.0', '2026-10-06')), '1.1.0', TODAY)).toBe(
      "CHANGELOG.md has no entry for 1.1.0: add `## [1.1.0] — 2026-10-20` with this release's changes first."
    );
    expect(changelogProblem(changelog(''), '1.0.0', TODAY)).toContain('no entry for 1.0.0');
  });

  it('refuses an entry dated another day, or none: the release day sets the date', () => {
    expect(changelogProblem(changelog(released('1.0.0', '2026-10-06')), '1.0.0', TODAY)).toBe(
      "CHANGELOG.md's entry for 1.0.0 is dated 2026-10-06, but the release day is 2026-10-20: make its heading `## [1.0.0] — 2026-10-20` first."
    );
    expect(changelogProblem(changelog('## [1.0.0]\n\n- A tool.\n'), '1.0.0', TODAY)).toBe(
      "CHANGELOG.md's entry for 1.0.0 has no date, but the release day is 2026-10-20: make its heading `## [1.0.0] — 2026-10-20` first."
    );
  });

  it('reads a heading with an em dash, an en dash or a hyphen, and CRLF line ends', () => {
    for (const dash of ['—', '–', '-']) {
      expect(
        changelogProblem(changelog(`## [1.0.0] ${dash} ${TODAY}\n\n- A tool.\n`), '1.0.0', TODAY),
        dash
      ).toBeUndefined();
    }
    expect(
      changelogProblem(changelog(released('1.0.0', TODAY)).replaceAll('\n', '\r\n'), '1.0.0', TODAY)
    ).toBeUndefined();
  });
});

describe('changelogSections', () => {
  it('lists the sections with their version, date and whether anything follows the heading', () => {
    const text = changelog(
      `## [Unreleased]\n\n## Not a version\n\nignored\n\n${released('1.0.0', '2026-10-06')}## [0.9.0]\n`
    );
    expect(changelogSections(text)).toEqual([
      { version: 'Unreleased', date: undefined, hasEntries: false },
      { version: '1.0.0', date: '2026-10-06', hasEntries: true },
      { version: '0.9.0', date: undefined, hasEntries: false },
    ]);
  });

  it('takes no heading from inside a comment', () => {
    const text = changelog(`<!--\n## [0.1.0] — 2026-01-01\n\n- Old.\n-->\n\n${released('1.0.0', TODAY)}`);
    expect(changelogSections(text)).toEqual([{ version: '1.0.0', date: TODAY, hasEntries: true }]);
  });
});

describe('localDate', () => {
  it('is the calendar day of the local time zone, zero-padded', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59, 59))).toBe('2026-01-05');
    expect(localDate(new Date(2026, 11, 31, 0, 0, 0))).toBe('2026-12-31');
    expect(localDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("this checkout's CHANGELOG.md", () => {
  it("holds the package version's entry, dated, or its changes waiting under Unreleased", () => {
    const sections = changelogSections(read('CHANGELOG.md'));
    const unreleased = sections.filter((s) => s.version.toLowerCase() === 'unreleased');
    expect(unreleased.length).toBeLessThanOrEqual(1);
    const entry = sections.find((s) => s.version === pkg.version);
    if (entry) expect(entry.date, `the date of ${pkg.version}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    else expect(unreleased[0]?.hasEntries, `${pkg.version} released, or its changes under Unreleased`).toBe(true);
  });

  it('keeps its notes above the first section, out of what a release publishes', () => {
    const text = read('CHANGELOG.md');
    const first = text.search(/^## \[/m);
    expect(first).toBeGreaterThan(-1);
    expect(text.slice(first)).not.toContain('<!--');
  });

  it('is checked by npm run release before anything runs', () => {
    const release = read('scripts/release.js');
    expect(release).toContain("from './changelog.mjs'");
    // The call must be there: indexOf gives -1 for a missing one, which is before everything.
    const checked = release.indexOf('changelogProblem(');
    expect(checked, 'release.js calls changelogProblem').toBeGreaterThan(-1);
    expect(checked).toBeLessThan(release.indexOf("run('npm ci')"));
  });
});
