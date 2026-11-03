// SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
// SPDX-License-Identifier: Apache-2.0
//
// What a release would ship from the checkout besides what `git status`
// shows: the tracked files whose edits it hides (skip-worktree and
// assume-unchanged, with the commands that clear those marks), and the
// git-ignored paths an archive would take — the
// npm tarball takes src/ and LICENSES/ whole (but for the files npm never
// packs), the MCPB bundle the whole checkout but for what .mcpbignore and
// mcpb's own exclusions drop. Read by scripts/release.js before anything
// runs, and by test/release-files.test.ts.

/** What @anthropic-ai/mcpb (the version release.js pins) never packs, besides what .mcpbignore lists: its EXCLUDE_PATTERNS. */
export const MCPB_EXCLUDES = [
  '.DS_Store',
  'Thumbs.db',
  '.gitignore',
  '.git',
  '.mcpbignore',
  '*.log',
  '.env*',
  '.npm',
  '.npmrc',
  '.yarnrc',
  '.yarn',
  '.eslintrc',
  '.editorconfig',
  '.prettierrc',
  '.prettierignore',
  '.eslintignore',
  '.nycrc',
  '.babelrc',
  '.pnp.*',
  'node_modules/.cache',
  'node_modules/.bin',
  '*.map',
  '.env.local',
  '.env.*.local',
  'npm-debug.log*',
  'yarn-debug.log*',
  'yarn-error.log*',
  'package-lock.json',
  'yarn.lock',
  '*.mcpb',
  '*.d.ts',
  '*.tsbuildinfo',
  'tsconfig.json',
];

/**
 * What npm never packs, even from a folder the `files` list takes whole:
 * npm-packlist's rules (npm 10). Its strict rules hold at the package root
 * only, so node_modules and package-lock.json are anchored there (a
 * node_modules folder under src/ is packed); its default rules hold in every
 * folder, so its `/build/config.gypi` matches at any depth here.
 */
export const NPM_EXCLUDES = [
  '.git',
  '.npmrc',
  '.gitignore',
  '.npmignore',
  '/node_modules',
  '/package-lock.json',
  '.DS_Store',
  '*.orig',
  '.*.swp',
  '._*',
  'npm-debug.log',
  'CVS',
  '.svn',
  '.hg',
  '.lock-wscript',
  '.wafpickle-*',
  '**/build/config.gypi',
  'archived-packages/',
];

/**
 * Whether npm packs a root file whatever the `files` list and the ignore
 * files say: README, COPYING, LICENSE and LICENCE, in any case, alone or with
 * an extension that does not end in `~` or `$` (npm-packlist's
 * `!/readme{,.*[^~$]}` and the like) — so a git-ignored README.log ships.
 * @param {string} path
 * @returns {boolean}
 */
export const npmAlwaysPacks = (path) => /^(readme|copying|licen[cs]e)(\.[^/]*[^~$/])?$/i.test(path);

/**
 * A gitignore-style pattern (as mcpb reads .mcpbignore and its own list) as a
 * test of a path: a pattern with no slash inside matches a path segment at any
 * depth — the whole folder, when it ends with a slash; one with a slash inside
 * is anchored at the root, unless it starts with `**` and a slash, which
 * match it at any depth. `*` and `?` stay within a segment. A path from
 * `git ls-files --directory` ends a folder's with a slash.
 * @param {string} pattern
 * @returns {(path: string) => boolean}
 */
export const ignoreRule = (pattern) => {
  const folder = pattern.endsWith('/');
  const text = pattern
    .replace(/\/$/, '')
    .replace(/^\*\*\//, '')
    .replace(/^\//, '');
  const anchored = !pattern.startsWith('**/') && (text.includes('/') || pattern.startsWith('/'));
  const depth = text.split('/').length;
  const glob = new RegExp(
    `^${text
      .split('*')
      .map((part) => part.replace(/[.+^${}()|[\]\\?]/g, (c) => (c === '?' ? '[^/]' : `\\${c}`)))
      .join('[^/]*')}$`
  );
  return (path) => {
    const segments = path.replace(/\/$/, '').split('/');
    const isFolder = (i) => i < segments.length - 1 || path.endsWith('/');
    /** Whether the pattern's segments match the path's from segment `start` on. */
    const matchesAt = (start) =>
      start + depth <= segments.length &&
      glob.test(segments.slice(start, start + depth).join('/')) &&
      (!folder || isFolder(start + depth - 1));
    return anchored ? matchesAt(0) : segments.some((_, i) => matchesAt(i));
  };
};

/**
 * The rules of a .mcpbignore file: one pattern per line, blank lines and
 * `#` comments left out.
 * @param {string} mcpbIgnore the file's text
 * @returns {string[]}
 */
export const mcpbIgnoreRules = (mcpbIgnore) =>
  mcpbIgnore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

/**
 * Whether an archive of the release would take a git-ignored path, given the
 * text of .mcpbignore: what the release remakes (node_modules, dist,
 * coverage) cannot carry a stray file along; the tarball takes the root
 * README, COPYING and LICENSE files (npmAlwaysPacks), and src/ and LICENSES/
 * whole, but for the files npm never packs; the bundle takes the rest of the
 * checkout, but for what .mcpbignore and mcpb itself drop.
 * @param {string} mcpbIgnore
 * @returns {(path: string) => boolean}
 */
export const shipCheck = (mcpbIgnore) => {
  const mcpbDrops = [...mcpbIgnoreRules(mcpbIgnore), ...MCPB_EXCLUDES].map(ignoreRule);
  const npmDrops = NPM_EXCLUDES.map(ignoreRule);
  return (path) => {
    if (/^(node_modules|dist|coverage)\//.test(path)) return false;
    if (npmAlwaysPacks(path)) return true;
    if (/^(src|LICENSES)\//.test(path)) return !npmDrops.some((drops) => drops(path));
    return !mcpbDrops.some((drops) => drops(path));
  };
};

/**
 * The git-ignored files an archive of the release would take, from the paths
 * `git ls-files --others --ignored --exclude-standard --directory` lists: git
 * gives a new folder that holds only ignored files as the folder (alone, or
 * beside those files), so a folder an archive would take is judged by the
 * files in it, as `filesIn` lists them (a new src/ folder holding only a
 * .DS_Store ships nothing). Each file is named once.
 * @param {string[]} listed
 * @param {(path: string) => boolean} wouldShip as shipCheck returns it
 * @param {(folder: string) => string[]} filesIn
 * @returns {string[]}
 */
export const shippingIgnored = (listed, wouldShip, filesIn) => [
  ...new Set(
    listed.flatMap((path) => (path.endsWith('/') && wouldShip(path) ? filesIn(path) : [path])).filter(wouldShip)
  ),
];

/**
 * The entries of `git ls-files -v -z` naming a tracked file whose edits `git
 * status` would not show: tagged `S` (skip-worktree) or in lowercase
 * (assume-unchanged; `s` is both).
 * @param {string} lsFiles the command's output: entries ended by NUL, each path as it is
 * @returns {string[]}
 */
export const hiddenTracked = (lsFiles) => lsFiles.split('\0').filter((line) => /^[Sa-z] /.test(line));

/**
 * The commands that clear the marks of the files hiddenTracked names: one
 * `git update-index` call per mark, since a call given both flags clears
 * only the assume-unchanged mark and leaves a skip-worktree file as it was.
 * A path a shell would split or expand is single-quoted.
 * @param {string[]} hidden entries as hiddenTracked returns them
 * @returns {string[]}
 */
export const unhideCommands = (hidden) =>
  hidden.flatMap((line) => {
    const tag = line.charAt(0);
    const path = line.slice(2);
    const arg = /^[\w./@%+=:,-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
    const marks = [
      ...(tag === 'S' || tag === 's' ? ['skip-worktree'] : []),
      ...(tag === 'S' ? [] : ['assume-unchanged']),
    ];
    return marks.map((mark) => `git update-index --no-${mark} -- ${arg}`);
  });
