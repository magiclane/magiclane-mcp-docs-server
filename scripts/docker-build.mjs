// SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
// SPDX-License-Identifier: Apache-2.0
//
// Builds the Docker image with its OCI labels filled in: the version from
// package.json, the git revision (only when this folder is its own git
// checkout, marked "-dirty" when a file the image is built from differs from
// it — a tracked file changed, or an untracked one that would ship) and the
// build time — on the base image pinned by digest (node:22-slim@sha256:…,
// resolved now), so the build is reproducible and the image records its base.
// When neither buildx nor a local copy of the base image gives a digest
// (offline, or Docker Hub rate-limiting), it builds on the tag with a warning,
// and the base.name label says the tag. A plain `docker build` skips all
// this: it uses the tag, its version and revision labels read "unknown", and
// its build time the Unix epoch.
// Usage: npm run docker:build [-- <extra docker build arguments>]; a -t/--tag
// given there (-t NAME, -tNAME, --tag NAME, --tag=NAME) replaces the default
// image name instead of adding to it.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const project = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const git = (...args) =>
  execFileSync('git', ['-C', project, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();

/** What the Dockerfile copies from the build context. */
const SHIPPED = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'rollup.config.js',
  'src',
  'LICENSE',
  'LICENSES',
  'README.md',
  'REUSE.toml',
  'Dockerfile',
];

/**
 * The commit the image is built from: only when this folder is the top of its
 * own git checkout (an archive unpacked inside another repository must not get
 * that repository's commit), with "-dirty" when files differ from it.
 */
function revisionOf() {
  try {
    if (realpathSync(git('rev-parse', '--show-toplevel')) !== project) return 'unknown';
    const head = git('rev-parse', 'HEAD');
    // Tracked files anywhere, and untracked ones among what the Dockerfile
    // copies in (ignored files, such as node_modules, never count).
    const tracked = git('status', '--porcelain', '--untracked-files=no');
    const untracked = git('status', '--porcelain', '--untracked-files=all', '--', ...SHIPPED);
    return tracked === '' && untracked === '' ? head : `${head}-dirty`;
  } catch {
    return 'unknown'; // not a git checkout (a tarball, say), or no git
  }
}
const revision = revisionOf();
const created = new Date().toISOString();

const BASE = 'node:22-slim';
/** The base image's current digest, or undefined when it cannot be resolved (offline, no buildx). */
function baseDigest() {
  const attempts = [
    ['buildx', 'imagetools', 'inspect', BASE, '--format', '{{json .Manifest.Digest}}'],
    ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', BASE],
  ];
  for (const attempt of attempts) {
    try {
      const out = execFileSync('docker', attempt, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const digest = /sha256:[0-9a-f]{64}/.exec(out)?.[0];
      if (digest) return digest;
    } catch {
      // try the next way
    }
  }
  return undefined;
}
const digest = baseDigest();
const nodeImage = digest ? `${BASE}@${digest}` : BASE;
if (!digest) console.warn(`Could not resolve the digest of ${BASE}: building on the tag as it is today.`);

const extra = process.argv.slice(2);
const args = [
  'build',
  '--build-arg',
  `VERSION=${version}`,
  '--build-arg',
  `REVISION=${revision}`,
  '--build-arg',
  `CREATED=${created}`,
  '--build-arg',
  `NODE_IMAGE=${nodeImage}`,
  // The default name, unless the caller names the image (-t / --tag) itself.
  ...(extra.some((a) => a === '--tag' || a.startsWith('--tag=') || /^-t/.test(a))
    ? []
    : ['-t', 'magiclane-mcp-docs-server']),
  ...extra,
  '.',
];
console.log(`> docker ${args.join(' ')}`);
const result = spawnSync('docker', args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
