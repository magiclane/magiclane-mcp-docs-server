/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What the published package promises users who never see the source: its
 * commands (`npx -y @magiclane/mcp-docs-server` starts the stdio server: of
 * several commands, npx runs the one named after the package), that the
 * packed tarball holds each command's file, that no page configures the
 * command named after the package, and that its REUSE.toml, which ships beside the production node_modules in the MCPB
 * bundle, the Docker image and an installed copy, claims only the project's
 * own files.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json')) as { name: string; bin: Record<string, string>; files: string[] };

describe('package.json', () => {
  it('has one command per transport, and one named after the package for npx', () => {
    expect(pkg.bin).toEqual({
      'mcp-docs-server': 'dist/docs-server.esm.js',
      'magiclane-mcp-docs': 'dist/docs-server.esm.js',
      'magiclane-mcp-docs-http': 'dist/docs-server-http.esm.js',
    });
    // With several commands, `npx -y <package>` runs the one whose name is the
    // package name without its scope — or refuses ("could not determine
    // executable to run").
    const unscoped = pkg.name.replace(/^@[^/]+\//, '');
    expect(pkg.bin[unscoped]).toBe('dist/docs-server.esm.js');
  });
});

describe('the documentation pages', () => {
  // Client configurations name magiclane-mcp-docs: mcp-docs-server is there
  // for `npx -y @magiclane/mcp-docs-server`.
  const pages = [
    'README.md',
    ...readdirSync(new URL('../docs/', import.meta.url))
      .filter((file) => file.endsWith('.md'))
      .map((file) => `docs/${file}`),
  ];
  it('never configure the generic command', () => {
    for (const page of pages) expect(read(page), page).not.toMatch(/"command":\s*"mcp-docs-server"/);
  });
});

describe.skipIf(!existsSync(`${root}dist/docs-server.esm.js`))('the packed tarball (needs a build)', () => {
  it("holds every command's file, so each command resolves once installed", () => {
    // What `npm pack` would take, without writing the tarball. The pack runs
    // the prepare script all the same: HUSKY=0 keeps it from installing git
    // hooks in the checkout, and husky says so on stdout, before the JSON.
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      env: { ...process.env, HUSKY: '0', npm_config_update_notifier: 'false' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    });
    const [packed] = JSON.parse(out.slice(out.indexOf('['))) as [{ files: Array<{ path: string }> }];
    const paths = new Set(packed.files.map((f) => f.path));
    for (const [command, file] of Object.entries(pkg.bin)) expect(paths.has(file), `${command} -> ${file}`).toBe(true);
    expect(paths.has('package.json')).toBe(true);
  });
});

describe('REUSE.toml', () => {
  it("claims only the project's own paths, never node_modules", () => {
    const paths = [...read('REUSE.toml').matchAll(/^path = (.+)$/gm)].flatMap(
      (m) => JSON.parse(m[1] as string) as string | string[]
    );
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path, path).not.toBe('**');
      expect(path.startsWith('node_modules'), path).toBe(false);
      // A top-level glob matches no folder: "*" covers the top-level files only.
      expect(path === '*' || /^[.\w-]+\/\*\*$/.test(path), path).toBe(true);
    }
  });
});
