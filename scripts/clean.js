// SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
// SPDX-License-Identifier: Apache-2.0
//
// Removes build output directories using only Node.js built-ins.
// Works in both dev and production environments (no devDependency on shx).
//
// Resilient to:
//   - ENOENT: directory does not exist (handled by `force: true`)
//   - EACCES / EPERM: directory exists but is owned by another user
//     (common in Docker images where `dist/` was created at image build time
//     by root and the runtime container runs as a non-root user). We log a
//     warning and continue so the rollup build that follows can overwrite
//     the files it owns rather than aborting the whole build.
import { rmSync } from 'node:fs';

for (const dir of ['dist', 'coverage']) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
      console.warn(`[clean] Skipping ${dir}: ${err.code} (${err.message}). Continuing.`);
      continue;
    }
    throw err;
  }
}
