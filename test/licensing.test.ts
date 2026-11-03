/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The part of `reuse lint` that needs no Python: every license a file is
 * labelled with (an SPDX header, or an annotation in REUSE.toml) has its text
 * in LICENSES/, and every text there is used. A label without its text (the
 * code of conduct's CC BY-SA once) fails here, in `npm test`, before the
 * release's full `reuse lint` would.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', 'dist', 'coverage', '.git', 'resources', 'LICENSES', '.eval', 'Claude outputs']);
const TEXT =
  /\.(ts|mts|js|mjs|json|md|toml|yml|yaml|txt)$|^(Dockerfile|\.[a-z]+ignore|\.gitattributes|\.env\.example)$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return TEXT.test(name) ? [path] : [];
  });
}

// REUSE-IgnoreStart (the pattern below is not this file's license)
/** License identifiers in SPDX headers (`SPDX-License-Identifier: X`) and REUSE.toml (`SPDX-License-Identifier = "X"`). */
function usedLicenses(): Set<string> {
  const used = new Set<string>();
  for (const path of files(ROOT)) {
    // This file names the pattern, not a license.
    if (path.endsWith('licensing.test.ts')) continue;
    for (const [, id] of readFileSync(path, 'utf8').matchAll(
      /SPDX-License-Identifier\s*[:=]\s*"?([A-Za-z0-9.+-]+)"?/g
    )) {
      used.add(id as string);
    }
  }
  return used;
}
// REUSE-IgnoreEnd

describe('licensing', () => {
  it('has the text of every license a file is labelled with, and no unused one', () => {
    const used = usedLicenses();
    const texts = new Set(readdirSync(join(ROOT, 'LICENSES')).map((name) => name.replace(/\.txt$/, '')));
    expect(used.size).toBeGreaterThan(0);
    expect(
      [...used].filter((id) => !texts.has(id)),
      'labels without a license text'
    ).toEqual([]);
    expect(
      [...texts].filter((id) => !used.has(id)),
      'license texts nothing uses'
    ).toEqual([]);
  });

  it("labels the project's own files Apache-2.0 by default in REUSE.toml", () => {
    // Line endings as checked out (CRLF on a Windows checkout made before .gitattributes) do not matter.
    const toml = readFileSync(join(ROOT, 'REUSE.toml'), 'utf8').replace(/\r\n/g, '\n');
    expect(toml).toMatch(
      /path = \[.*"src\/\*\*".*\]\nprecedence = "aggregate"\n[^[]*SPDX-License-Identifier = "Apache-2.0"/
    );
  });
});
