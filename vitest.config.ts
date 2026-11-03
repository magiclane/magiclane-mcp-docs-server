/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * A checkout's root folder as the start of a coverage glob: the glob syntax
 * a folder name may hold escaped, since a checkout under "Projects (work)"
 * would otherwise match nothing. Only what either matcher reads as syntax:
 * `(`, `)`, `[`, `]`, `{`, `}`, `*` and `?` anywhere, and `+`, `!` and `@`
 * only before a `(` (an extglob). Escaped elsewhere, those three are read
 * literally by picomatch, which matches the files the tests load, but not by
 * tinyglobby, which crawls for the files no test loads: a checkout under
 * "C++" then had a new source file nothing imports left out of the report.
 * A `|` is refused instead, since no escape here reaches the pattern it
 * breaks: vitest adds this file's own path to the coverage excludes as it is,
 * picomatch reads the `|` in it as "or", and the part before it then excludes
 * every file of the checkout — the gate passed on 0% of no files.
 */
export const coverageGlobRoot = (root: string): string => {
  if (root.includes('|')) {
    throw new Error(
      `This checkout's path holds a "|" (${root}): vitest adds the path of vitest.config.ts to the coverage ` +
        'excludes unescaped, where the "|" excludes every source, so the 100% gate would pass on no file. ' +
        'Move the checkout to a folder whose path has no "|".'
    );
  }
  return root.replace(/[()[\]{}*?]|[+!@](?=\()/g, '\\$&');
};

/**
 * A path in this checkout as a coverage glob: absolute, since coverage matches
 * its patterns anywhere in a file's absolute path and a relative `src/**`
 * would also take in test/ files of a checkout under a folder such as ~/src;
 * with forward slashes, since a Windows backslash is an escape in a glob (with
 * C:\… paths nothing matched: 0% of no files); and with the folder's glob
 * syntax escaped (see coverageGlobRoot, which refuses a path holding a `|`).
 */
const here = (path: string): string => {
  const root = fileURLToPath(new URL('.', import.meta.url)).replaceAll('\\', '/');
  return `${coverageGlobRoot(root)}${path.replace(/^\.\//, '')}`;
};

/** The live suite runs only under `npm run test:live` (LIVE_DOCS_TESTS=1); elsewhere it is not even listed as skipped. */
const live = Boolean(process.env.LIVE_DOCS_TESTS);

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(live ? [] : ['test/integration.test.ts'])],
    setupFiles: ['test/setup.ts'],
    /** Single source of truth for test timeouts — no manual timers in tests. */
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: [here('./src/**/*.ts')],
      // The two process entry points only wire things together (read env,
      // listen, handle signals). The stdio one is exercised by the opt-in
      // test/integration.test.ts as a subprocess, which unit coverage cannot
      // measure; all logic lives in src/http/app.ts and src/server.ts, which
      // are covered.
      exclude: [here('./src/docs-server.ts'), here('./src/docs-server-http.ts')],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
