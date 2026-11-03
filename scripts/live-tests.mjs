// SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
// SPDX-License-Identifier: Apache-2.0
//
// Runs the end-to-end suite against the BUILT server and the LIVE
// documentation site. Opt-in (it needs the network and a build), so `npm test`
// stays offline and hermetic. Usage: npm run test:live
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync('dist/docs-server.esm.js') || !existsSync('dist/docs-server-http.esm.js')) {
  console.error('test:live needs a build: run `npm run build` first.');
  process.exit(1);
}

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vitest', 'run', 'test/integration.test.ts'],
  { stdio: 'inherit', env: { ...process.env, LIVE_DOCS_TESTS: '1' }, shell: process.platform === 'win32' }
);
process.exit(result.status ?? 1);
