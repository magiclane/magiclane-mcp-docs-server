// SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
// SPDX-License-Identifier: Apache-2.0
//
// Keeps manifest.json's `tools` and `version` in step with the server. The
// tool list is derived from the tool classes themselves, so the MCPB manifest
// can never describe a tool differently from what the server registers.
//
//   node scripts/sync-manifest.mjs          rewrite manifest.json
//   node scripts/sync-manifest.mjs --check  exit 1 when manifest.json is stale
import { readFileSync, writeFileSync } from 'node:fs';
import { format, resolveConfig } from 'prettier';
import { register } from 'tsx/esm/api';

// tsx compiles the TypeScript sources on the fly (same as `npm run dev`).
register();
const { createTools } = await import('../src/server.ts');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

const manifestPath = 'manifest.json';
const current = readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(current);
const expected = {
  ...manifest,
  version: pkg.version,
  tools: createTools().map((tool) => ({ name: tool.name, description: tool.description })),
};
// Format exactly as `npm run format` would, so a synced manifest also passes
// `prettier --check` (and the comparison ignores nothing but real changes).
const next = await format(JSON.stringify(expected, null, 2), {
  ...(await resolveConfig(manifestPath)),
  filepath: manifestPath,
});

if (process.argv.includes('--check')) {
  if (current !== next) {
    console.error('manifest.json is out of date: run `npm run sync:manifest`.');
    process.exit(1);
  }
  console.log('manifest.json matches the server.');
} else if (current !== next) {
  writeFileSync(manifestPath, next);
  console.log('manifest.json updated.');
} else {
  console.log('manifest.json already up to date.');
}
