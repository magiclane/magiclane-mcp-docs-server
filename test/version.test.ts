/**
 * SPDX-FileCopyrightText: 2025-2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SERVER_NAME, SERVER_VERSION } from '../src/version.js';
import { FETCH } from '../src/config/constants.js';

/** package.json as the repository actually has it — the source of truth. */
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
};

describe('version', () => {
  it('reads NAME and VERSION straight from package.json', () => {
    expect(SERVER_NAME).toBe(pkg.name);
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it('exposes them as plain strings, not `any` from JSON.parse', () => {
    expect(typeof SERVER_NAME).toBe('string');
    expect(typeof SERVER_VERSION).toBe('string');
  });

  it('carries a semver-shaped version', () => {
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('FETCH.userAgent', () => {
  it('is built from the package name and version rather than a literal', () => {
    expect(FETCH.userAgent).toBe(`${pkg.name.replace(/^@/, '').replace(/\//g, '-')}/${pkg.version}`);
  });

  it('flattens the npm scope into an HTTP-token-safe identifier', () => {
    expect(FETCH.userAgent).not.toContain('@');
    expect(FETCH.userAgent.split('/')).toHaveLength(2);
  });
});

describe('release metadata stays in sync', () => {
  it('manifest.json declares the same version as package.json', () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(manifest.version).toBe(pkg.version);
  });
});
