/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The coverage patterns must name this checkout's own files on every system
 * and under any folder name, for both matchers vitest's coverage uses:
 * picomatch for the files the tests load, and tinyglobby, which crawls the
 * checkout for the files no test loaded (then picomatch again). A relative
 * pattern also takes in files of a checkout under a folder such as ~/src; a
 * Windows path with backslashes (an escape in a glob) matches nothing; a path
 * holding glob syntax — "Projects (work)" — matches nothing unless escaped;
 * and a character escaped that is not glob syntax there — the `+` of "C++" —
 * is read literally by picomatch but not by tinyglobby, which then crawls a
 * folder that does not exist and finds no untested file. In each case the
 * gate reports 0% of no files, passes on nothing, or misses a new file. So
 * the patterns are matched here with what vitest adds to the excludes itself;
 * one of those, the config's own path, is added unescaped, and under a folder
 * named with `|` it excludes every file: such a checkout is refused.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore picomatch ships no types; it is vitest's own matcher, used here as vitest uses it.
import picomatch from 'picomatch';
import { glob } from 'tinyglobby';
import { afterAll, describe, expect, it } from 'vitest';
import config, { coverageGlobRoot } from '../vitest.config.js';

const root = fileURLToPath(new URL('..', import.meta.url)).replaceAll('\\', '/');
const { include, exclude } = config.test?.coverage as { include: string[]; exclude: string[] };

/**
 * What vitest 4 adds to the coverage excludes of a checkout at `dir` itself,
 * as it adds them: the setup and test files relative to the root, and the
 * path of the config file, absolute and unescaped.
 */
const vitestExcludes = (dir: string): string[] => [
  ...(config.test?.setupFiles as string[]),
  ...(config.test?.include as string[]),
  `${dir}vitest.config.ts`,
];

/** As vitest's coverage provider matches a loaded file against the patterns. */
const matches = (file: string, pattern: string, ignore: string[] = []): boolean =>
  picomatch.isMatch(file, pattern, { contains: true, dot: true, ignore });

/** As vitest finds the files no test loaded: tinyglobby's crawl of the root, then picomatch over what it found. */
async function untested(pattern: string, cwd: string, ignore: string[]): Promise<string[]> {
  const found = await glob(pattern, { cwd, ignore, absolute: true, dot: true, onlyFiles: true });
  return found.filter((file) => matches(file, pattern, ignore)).sort();
}

describe('coverage patterns', () => {
  it("match this checkout's own sources, and only those, however the folder is named", () => {
    const ignore = [...exclude, ...vitestExcludes(root)];
    expect(matches(`${root}src/server.ts`, include[0] as string, ignore)).toBe(true);
    expect(matches(`${root}test/helpers.ts`, include[0] as string, ignore)).toBe(false);
    for (const pattern of [...include, ...exclude]) expect(pattern, pattern).not.toContain('\\\\');
  });

  it("find this checkout's sources that no test loaded, the entry points excluded", async () => {
    const files = await untested(include[0] as string, root, [...exclude, ...vitestExcludes(root)]);
    expect(files).toContain(`${root}src/server.ts`);
    expect(files.some((file) => file.endsWith('/docs-server.ts') || file.endsWith('/docs-server-http.ts'))).toBe(false);
    expect(files.some((file) => file.includes('/test/'))).toBe(false);
  });

  describe('under awkward folder names', () => {
    const base = mkdtempSync(join(tmpdir(), 'coverage-glob-'));
    afterAll(() => rmSync(base, { recursive: true, force: true }));

    /** A checkout-shaped folder: two loaded sources, an entry point to exclude, a source nothing imports, a test. */
    function checkout(name: string): string {
      const dir = `${join(base, name, 'm').replaceAll('\\', '/')}/`;
      mkdirSync(`${dir}src/utils`, { recursive: true });
      mkdirSync(`${dir}test`, { recursive: true });
      for (const file of ['src/server.ts', 'src/docs-server.ts', 'src/utils/never-imported.ts', 'test/helpers.ts']) {
        writeFileSync(`${dir}${file}`, '');
      }
      return dir;
    }

    // Glob syntax anywhere; `+`, `!` and `@` as the extglob they start before a
    // parenthesis, and as the plain characters they are elsewhere. (A `|` is
    // refused: see below.)
    const names = ['Projects (work)', '[mcp]', 'a{b,c}', 'a*b', 'a?b', 'C++', 'x!y', 'a@b', '@(x)', '!(x)', 'a+(b)'];
    // Windows allows neither `*` nor `?` in a folder name.
    const possible = names.filter((name) => process.platform !== 'win32' || !/[*?]/.test(name));

    it.each(possible)('both matchers find the sources, and only those, under "%s"', async (name) => {
      const dir = checkout(name);
      const pattern = `${coverageGlobRoot(dir)}src/**/*.ts`;
      const ignore = [`${coverageGlobRoot(dir)}src/docs-server.ts`, ...vitestExcludes(dir)];
      expect(matches(`${dir}src/server.ts`, pattern, ignore)).toBe(true);
      expect(matches(`${dir}test/helpers.ts`, pattern, ignore)).toBe(false);
      expect(matches(`${dir}src/docs-server.ts`, pattern, ignore)).toBe(false);
      expect(await untested(pattern, dir, ignore)).toEqual([
        `${dir}src/server.ts`,
        `${dir}src/utils/never-imported.ts`,
      ]);
    });

    it('refuse a folder named with "|", where the config path vitest excludes takes in every file', () => {
      const dir = `${join(base, 'a|b', 'm').replaceAll('\\', '/')}/`;
      // Even with the "|" escaped in the include, picomatch reads the one in
      // the config's path, which vitest adds to the excludes, as "or".
      const pattern = `${dir.replaceAll('|', '\\|')}src/**/*.ts`;
      expect(matches(`${dir}src/server.ts`, pattern)).toBe(true);
      expect(matches(`${dir}src/server.ts`, pattern, vitestExcludes(dir))).toBe(false);
      expect(() => coverageGlobRoot(dir)).toThrow(`This checkout's path holds a "|" (${dir})`);
    });

    it('match nothing unescaped', () => {
      const dir = `${join(base, 'Projects (work)', 'm').replaceAll('\\', '/')}/`;
      expect(matches(`${dir}src/server.ts`, `${dir}src/**/*.ts`)).toBe(false);
    });
  });
});
