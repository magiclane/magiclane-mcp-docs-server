/**
 * SPDX-FileCopyrightText: 2025-2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Package identity, read from package.json so it is never duplicated in code.
 * `..` resolves to the package root both when running from source (src/) and
 * from the rollup bundle (dist/), since this module is inlined into the latter.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as {
  name: string;
  version: string;
};

export const SERVER_VERSION: string = packageJson.version;
export const SERVER_NAME: string = packageJson.name;
