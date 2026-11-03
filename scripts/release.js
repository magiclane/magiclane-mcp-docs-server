// SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
// SPDX-License-Identifier: Apache-2.0
//
// Release pipeline, from a clean git clone with REUSE 6.2.0 at hand and a
// CHANGELOG.md entry for this version dated today (all checked first): clean
// install from the lockfile -> every local gate (which builds first, so the
// built bundle is checked too) -> reuse lint -> audit -> MCPB bundle (manifest
// + dist + production node_modules) -> npm tarball -> dev install restored.
// Usage: node scripts/release.js
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { changelogProblem, localDate } from './changelog.mjs';
import { hiddenTracked, shipCheck, shippingIgnored, unhideCommands } from './release-files.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

/** Pinned so a release never depends on whatever `latest` is that day. */
const MCPB = '@anthropic-ai/mcpb@2.1.2';

const run = (cmd) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
};

/** Pinned too: a newer REUSE can read the same files differently. */
const REUSE = '6.2.0';

/**
 * The REUSE tool (Python), at the pinned version: an installed copy if it is
 * that version, otherwise run through uv or pipx, which fetch that version.
 * The offline licensing test in `npm test` checks the license texts; `reuse
 * lint` also checks that every file carries a copyright and a license.
 */
const reuseLint = () => {
  const candidates = ['reuse', `uvx reuse@${REUSE}`, `pipx run --spec reuse==${REUSE} reuse`];
  for (const tool of candidates) {
    try {
      const version = execSync(`${tool} --version`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      if (version.includes(`version ${REUSE}`)) return `${tool} lint`;
    } catch {
      // not available this way: try the next
    }
  }
  console.error(
    `\nreuse lint needs REUSE ${REUSE}: install uv or pipx (they fetch that version), or \`pipx install reuse==${REUSE}\`, then release again.`
  );
  process.exit(1);
};

/**
 * reuse lint skips what .gitignore lists (node_modules, dist, coverage) only
 * in a git checkout, and lints the whole checkout it is in; elsewhere — a
 * source archive, or one unpacked inside another repository — it reads the
 * wrong files and fails. So this folder must be the top of its own checkout
 * (a clone, or a submodule). Checked before anything runs.
 */
const inGitCheckout = () => {
  try {
    const top = execSync('git rev-parse --show-toplevel', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    return same(realpathSync(top), realpathSync(process.cwd()));
  } catch {
    return false;
  }
};

if (!inGitCheckout()) {
  console.error(
    '\nnpm run release needs a git clone of this project, run from its top folder: reuse lint skips node_modules, ' +
      'dist and coverage only there.'
  );
  process.exit(1);
}
// What ships is what is committed: an edited or untracked file (which the
// tarball's `src/` and REUSE.toml would take in) stops the release here, and
// a publish to the registry cannot be taken back.
const changes = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
  .toString()
  .trim();
if (changes !== '') {
  console.error(`\nnpm run release needs a clean working tree; commit or remove these first:\n${changes}`);
  process.exit(1);
}
// Nor does that status show a tracked file marked skip-worktree or
// assume-unchanged (`git update-index --skip-worktree`): its local edits would
// ship unseen. `git ls-files -v` tags such files S, or in lowercase; the
// commands that clear the marks take one call per mark.
const hidden = hiddenTracked(execSync('git ls-files -v -z', { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
if (hidden.length > 0) {
  console.error(
    '\nnpm run release needs every tracked file checked for changes; these are marked skip-worktree (S) or ' +
      `assume-unchanged (lowercase), so an edit to them would ship unseen:\n${hidden.join('\n')}\n` +
      `Clear the marks first, one call per mark:\n${unhideCommands(hidden).join('\n')}`
  );
  process.exit(1);
}
// Git-ignored files are not in that status either, yet some would ship all
// the same: the tarball takes src/ and LICENSES/ whole (with the files npm
// never packs, such as .DS_Store, left out) and the root README, COPYING and
// LICENSE files of any extension, and the bundle takes the whole checkout but
// for what .mcpbignore and mcpb's own exclusions drop (so a root .env,
// .DS_Store files and logs never ship: they are not in the way). What the
// release remakes (node_modules, dist) cannot carry a stray file along. A new
// folder that git lists as one, holding only ignored files, is judged by them.
// The rules are in release-files.mjs (tested in test/release-files.test.ts);
// .mcpbignore is read here, after the checks that this is the top of a checkout.
const wouldShip = shipCheck(readFileSync('.mcpbignore', 'utf8'));
/** `git ls-files` of the git-ignored files, with `args` after its own: paths as they are. */
const ignoredFiles = (...args) =>
  execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .split('\0')
    .filter((path) => path !== '');
const ignored = shippingIgnored(ignoredFiles('--directory'), wouldShip, (folder) => ignoredFiles('--', folder));
if (ignored.length > 0) {
  console.error(
    '\nnpm run release found git-ignored files that would ship (the tarball takes src/ and LICENSES/ whole, and ' +
      'the root README, COPYING and LICENSE files; the bundle takes everything .mcpbignore does not drop); ' +
      `remove these first:\n${ignored.join('\n')}`
  );
  process.exit(1);
}
// What ships is described in CHANGELOG.md, whose entry for this version must
// be dated today: entries wait under "Unreleased", undated, until the release
// day, so no date goes stale while commits keep coming — and nothing may be
// left waiting there.
const changelog = changelogProblem(readFileSync('CHANGELOG.md', 'utf8'), pkg.version, localDate());
if (changelog !== undefined) {
  console.error(`\nnpm run release stopped: ${changelog}`);
  process.exit(1);
}
const reuse = reuseLint(); // found before anything runs, so a missing tool stops the release at once

run('npm ci'); // 1. exact dev install from package-lock.json
run('npm run check'); // 2. build, then the local gates: types, lint, format, spelling, manifest, tests + 100% coverage
run(reuse); // 3. every file labelled, every license text present: the licensing data that goes public
run('npm audit --omit=dev'); // 4. no known advisories in what ships
try {
  run('npm ci --omit=dev'); // 5. production node_modules only, for the bundle
  run(`npx -y ${MCPB} pack . magiclane-mcp-docs-server-${pkg.version}.mcpb`); // 6. the MCPB bundle (.mcpbignore keeps sources and tests out)
  run('npm pack'); // 7. npm tarball (`files` allowlist)
} finally {
  run('npm ci'); // 8. restore devDeps so the working tree stays usable, whatever happened above
}
