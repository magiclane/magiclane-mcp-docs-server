/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The MCPB manifest is shipped to users who never see the source: its tool
 * list must be exactly what the server registers (names AND descriptions),
 * and its version must be the package version. `npm run sync:manifest`
 * regenerates it from the tool classes. The Claude Desktop guide tells users
 * how to build the bundle without the release, as the release builds it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTools } from '../src/server.js';
import { SERVER_VERSION } from '../src/version.js';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as {
  manifest_version: string;
  privacy_policies?: string[];
  version: string;
  server: { entry_point: string; mcp_config: { args: string[] } };
  tools: Array<{ name: string; description: string }>;
};

describe('manifest.json', () => {
  it('lists exactly the tools the server registers, with the same descriptions', () => {
    expect(manifest.tools).toEqual(createTools().map((t) => ({ name: t.name, description: t.description })));
  });

  it('declares the package version and the built stdio entry point', () => {
    expect(manifest.version).toBe(SERVER_VERSION);
    expect(manifest.server.entry_point).toBe('dist/docs-server.esm.js');
    expect(manifest.server.mcp_config.args.join(' ')).toContain('dist/docs-server.esm.js');
  });

  it('uses a manifest version that knows every field it declares', () => {
    // privacy_policies arrived with MCPB manifest 0.3; under 0.1 `mcpb validate`
    // and `mcpb pack` reject the file and `npm run release` stops.
    expect(manifest.manifest_version).toBe('0.3');
    expect(manifest.privacy_policies?.length).toBeGreaterThan(0);
  });
});

describe('the bundle build in the Claude Desktop guide', () => {
  const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const guide = read('docs/claude-desktop-setup.md');
  const option = guide.slice(guide.indexOf('### Option D'), guide.indexOf('## 1. '));

  it('builds it as the release does, with the mcpb the release pins, but without the release', () => {
    const pinned = /const MCPB = '(@anthropic-ai\/mcpb@[\d.]+)'/.exec(read('scripts/release.js'))?.[1];
    expect(pinned).toBeDefined();
    // The build, then the production dependencies only, then the pinned mcpb.
    const steps = ['npm ci\n', 'npm run build\n', 'npm ci --omit=dev', `npx -y ${pinned} pack . `];
    const at = steps.map((step) => option.indexOf(step));
    expect(at, steps.join(', ')).not.toContain(-1);
    expect(
      at.every((i, n) => n === 0 || i > at[n - 1]!),
      steps.join(' < ')
    ).toBe(true);
  });

  it('names what npm run release needs on the release day, the CHANGELOG entry too', () => {
    expect(option).toContain('`npm run release`');
    for (const need of ['clean clone', 'REUSE', '`CHANGELOG.md` entry']) expect(option, need).toContain(need);
  });
});
