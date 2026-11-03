/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The checkout checks of `npm run release` (scripts/release-files.mjs): a
 * tracked file whose edits git status hides stops the release, and so does a
 * git-ignored file only when an archive would take it — the tarball takes
 * the root README, COPYING and LICENSE files and src/ and LICENSES/ whole
 * (but for what npm never packs), the bundle the rest of the checkout but for
 * what .mcpbignore and mcpb's own exclusions drop; a new folder git lists
 * alone is judged by its files. Measured against this checkout's own
 * .mcpbignore, and the rules npm 10 and mcpb 2.1.2 apply.
 */
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hiddenTracked,
  ignoreRule,
  mcpbIgnoreRules,
  npmAlwaysPacks,
  shipCheck,
  shippingIgnored,
  unhideCommands,
} from '../scripts/release-files.mjs';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const wouldShip = shipCheck(read('.mcpbignore'));

/** Whether git runs here: the release needs it, a test run from a source archive may not have it. */
const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * A new git repository in a temporary folder, for `use`, removed afterwards.
 * Neither the user's nor the system's git configuration, nor a GIT_DIR or
 * GIT_INDEX_FILE of an enclosing run (a hook), may reach it.
 */
function inRepo(use: (git: (...args: string[]) => string, dir: string, env: NodeJS.ProcessEnv) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'release-files-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'no-global-config') });
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  try {
    git('init', '-q');
    use(git, dir, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('ignoreRule', () => {
  it('matches a pattern without a slash against a segment at any depth, with * and ? within the segment', () => {
    const log = ignoreRule('*.log');
    expect(['a.log', 'docs/a.log', 'a/b/c.log'].map(log)).toEqual([true, true, true]);
    expect(['a.log.txt', 'dialog', 'log'].map(log)).toEqual([false, false, false]);
    expect(ignoreRule('tsconfig*.json')('tsconfig.build.json')).toBe(true);
    expect(ignoreRule('tsconfig*.json')('tsconfig.build.json5')).toBe(false);
    expect(ignoreRule('.pnp.*')('.pnp.cjs')).toBe(true);
    expect(ignoreRule('.*.swp')('src/.index.ts.swp')).toBe(true);
    expect(ignoreRule('npm-debug.log*')('npm-debug.log.1')).toBe(true);
    // A dot is a dot, not any character.
    expect(ignoreRule('.env')('env')).toBe(false);
  });

  it('takes a trailing slash for a folder, at any depth, and a slash inside as anchored at the root', () => {
    const src = ignoreRule('src/');
    expect(['src/', 'src/a.ts', 'other/src/a.ts'].map(src)).toEqual([true, true, true]);
    expect(['src', 'source/a.ts'].map(src)).toEqual([false, false]);
    const github = ignoreRule('**/.github/');
    expect(github('node_modules/x/.github/FUNDING.yml')).toBe(true);
    expect(github('.github/')).toBe(true);
    const cache = ignoreRule('node_modules/.cache');
    expect(cache('node_modules/.cache/x')).toBe(true);
    expect(cache('a/node_modules/.cache/x')).toBe(false);
    expect(ignoreRule('/.env')('src/.env')).toBe(false);
    expect(ignoreRule('/.env')('.env')).toBe(true);
  });

  it('matches a pattern with a slash inside at any depth when it starts with **/', () => {
    const gypi = ignoreRule('**/build/config.gypi');
    expect(['build/config.gypi', 'src/build/config.gypi', 'src/a/build/config.gypi'].map(gypi)).toEqual([
      true,
      true,
      true,
    ]);
    expect(['src/config.gypi', 'src/build/config.gypi.bak', 'build/x/config.gypi'].map(gypi)).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe('shipCheck', () => {
  it("reads .mcpbignore's patterns, without comments and blank lines", () => {
    expect(mcpbIgnoreRules('# what the bundle must not carry\nsrc/\n\n  *.log  \n')).toEqual(['src/', '*.log']);
    expect(mcpbIgnoreRules(read('.mcpbignore'))).toContain('src/');
  });

  it('refuses a git-ignored file an archive would take', () => {
    for (const path of ['src/.env', 'src/debug.log', 'eslint-report.json', 'LICENSES/x.log', 'src/x.tsbuildinfo']) {
      expect(wouldShip(path), path).toBe(true);
    }
    // npm drops node_modules and package-lock.json at the package root only,
    // and config.gypi only in a build/ folder.
    for (const path of ['src/node_modules/x/index.js', 'src/x/package-lock.json', 'src/config.gypi']) {
      expect(wouldShip(path), path).toBe(true);
    }
  });

  it("refuses the root README, COPYING and LICENSE files npm packs whatever it is told, but npm's backups", () => {
    for (const path of ['README.log', 'LICENSE.log', 'license.tgz', 'Readme.mcpb', 'COPYING.log', 'licence.txt.log']) {
      expect(npmAlwaysPacks(path), path).toBe(true);
      expect(wouldShip(path), path).toBe(true);
    }
    for (const path of ['README.md~', 'readme.x$', 'readme.', 'READMEs.log', 'docs/README.log', 'LICENSES/x']) {
      expect(npmAlwaysPacks(path), path).toBe(false);
    }
  });

  it('lets through what no archive takes: dropped by .mcpbignore, by mcpb and npm themselves, or remade', () => {
    const allowed = ['.env', '.DS_Store', 'src/.DS_Store', 'LICENSES/.DS_Store', 'npm-debug.log', '.env.local'];
    allowed.push(
      'docs/x.log',
      'test/.env',
      'x.tgz',
      'x.mcpb',
      '.husky/_/',
      'node_modules/',
      'dist/',
      'coverage/lcov.info',
      // npm's default rules hold in every folder.
      'src/build/config.gypi',
      'src/x/.lock-wscript',
      'src/.wafpickle-1',
      'src/archived-packages/a.js',
      'src/.npmrc'
    );
    for (const path of allowed) expect(wouldShip(path), path).toBe(false);
  });
});

describe('shippingIgnored', () => {
  it('judges a folder git lists by the files in it, only a folder an archive would take, and each file once', () => {
    const files: Record<string, string[]> = {
      'src/newdir/': ['src/newdir/.DS_Store'],
      'sub/': ['sub/node_modules/q.js', 'sub/coverage/q.json'],
    };
    const filesIn = (folder: string): string[] => {
      const inside = files[folder];
      if (inside === undefined) throw new Error(`${folder} is not to be listed`);
      return inside;
    };
    const listed = ['src/newdir/', 'src/newdir/.DS_Store', 'sub/', 'sub/node_modules/q.js', 'README.log'];
    listed.push('docs/x.log', 'node_modules/', 'docs/');
    expect(shippingIgnored(listed, wouldShip, filesIn)).toEqual(['sub/node_modules/q.js', 'README.log']);
  });
});

describe.skipIf(!hasGit)('the git-ignored files of a git checkout', () => {
  it('are judged file by file, also in a folder git lists whole, as the release lists them', () => {
    inRepo((git, dir) => {
      writeFileSync(join(dir, '.gitignore'), '.DS_Store\nnode_modules/\n*.log\n');
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src/server.ts'), '');
      git('add', '.gitignore', 'src/server.ts');
      for (const file of ['src/newdir/.DS_Store', 'src/node_modules/x/index.js', 'src/debug.log', 'README.log']) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), '');
      }
      const ignored = (...args: string[]): string[] =>
        git('ls-files', '--others', '--ignored', '--exclude-standard', '-z', ...args)
          .split('\0')
          .filter((path) => path !== '');
      const listed = ignored('--directory');
      // Folders that hold only ignored files come as the folder.
      expect(listed).toEqual(expect.arrayContaining(['src/newdir/', 'src/node_modules/']));
      expect(listed).not.toContain('src/node_modules/x/index.js');
      expect(shippingIgnored(listed, wouldShip, (folder) => ignored('--', folder)).sort()).toEqual([
        'README.log',
        'src/debug.log',
        'src/node_modules/x/index.js',
      ]);
    });
  });
});

describe('hiddenTracked', () => {
  it('names the files tagged skip-worktree (S) or assume-unchanged (lowercase), and no other', () => {
    const entries = ['H src/a.ts', 'S src/b.ts', 'h src/c.ts', 's src/d e.ts', 'H test/d.ts', ''].join('\0');
    expect(hiddenTracked(entries)).toEqual(['S src/b.ts', 'h src/c.ts', 's src/d e.ts']);
    expect(hiddenTracked('H src/a.ts\0')).toEqual([]);
  });
});

describe('unhideCommands', () => {
  it('clears each mark with a call of its own, two for a file with both', () => {
    expect(unhideCommands(['S src/b.ts', 'h src/c.ts', 's src/d.ts'])).toEqual([
      'git update-index --no-skip-worktree -- src/b.ts',
      'git update-index --no-assume-unchanged -- src/c.ts',
      'git update-index --no-skip-worktree -- src/d.ts',
      'git update-index --no-assume-unchanged -- src/d.ts',
    ]);
  });

  it('quotes a path a shell would split or expand', () => {
    expect(unhideCommands(["S docs/it's here.md", 'h src/$x.ts'])).toEqual([
      "git update-index --no-skip-worktree -- 'docs/it'\\''s here.md'",
      "git update-index --no-assume-unchanged -- 'src/$x.ts'",
    ]);
  });
});

describe.skipIf(!hasGit)('the marks in a git checkout', () => {
  it('are all cleared by those commands, while one call given both flags leaves skip-worktree set', () => {
    inRepo((git, dir, env) => {
      const mark = (): void => {
        git('update-index', '--skip-worktree', 'both.ts', 'skip.ts');
        git('update-index', '--assume-unchanged', 'both.ts', 'assume.ts');
      };
      for (const file of ['assume.ts', 'both.ts', 'skip.ts']) writeFileSync(join(dir, file), '');
      git('add', '.');
      mark();
      const hidden = hiddenTracked(git('ls-files', '-v', '-z'));
      expect(hidden).toEqual(['h assume.ts', 's both.ts', 'S skip.ts']);
      git('update-index', '--no-skip-worktree', '--no-assume-unchanged', 'assume.ts', 'both.ts', 'skip.ts');
      expect(hiddenTracked(git('ls-files', '-v', '-z'))).toEqual(['S both.ts', 'S skip.ts']);
      git('update-index', '--no-skip-worktree', 'both.ts', 'skip.ts');
      mark();
      for (const command of unhideCommands(hidden)) execSync(command, { cwd: dir, env, stdio: 'ignore' });
      expect(hiddenTracked(git('ls-files', '-v', '-z'))).toEqual([]);
    });
  });
});
