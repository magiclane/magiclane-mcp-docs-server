// SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
// SPDX-License-Identifier: Apache-2.0
//
// Runs husky only when installed (i.e. in a dev environment).
// Silently skips in production installs where devDependencies are omitted.
import { accessSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const huskyBin = join(__dirname, '..', 'node_modules', '.bin', 'husky');

try {
  accessSync(huskyBin);
  execSync('husky', { stdio: 'inherit' });
} catch {
  // husky not installed (production install) — skip silently
}
