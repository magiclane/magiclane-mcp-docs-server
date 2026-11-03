/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { CACHE, DOCS, FETCH, HTTP, LIMITS, isAllowedDocUrl } from '../../src/config/constants.js';

describe('DOCS', () => {
  it('defines the Magic Lane developer site as base URL and single allowed host', () => {
    expect(DOCS.baseUrl).toBe('https://developer.magiclane.com');
    expect(DOCS.host).toBe('developer.magiclane.com');
  });

  it('declares at least the developer and flutter doc sources with unique ids', () => {
    const ids = DOCS.sources.map((s) => s.id);
    expect(ids).toContain('developer');
    expect(ids).toContain('flutter');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('roots every index URL at the base URL', () => {
    for (const source of DOCS.sources) {
      expect(source.indexUrl.startsWith(DOCS.baseUrl)).toBe(true);
      if (source.fullTextUrl) expect(source.fullTextUrl.startsWith(DOCS.baseUrl)).toBe(true);
    }
  });
});

describe('limit dictionaries', () => {
  it('keeps every numeric limit strictly positive', () => {
    const numeric = [
      ...Object.values(FETCH),
      ...Object.values(CACHE),
      ...Object.values(LIMITS),
      ...Object.values(HTTP),
    ].filter((value): value is number => typeof value === 'number');

    expect(numeric.length).toBeGreaterThan(0);
    for (const value of numeric) {
      expect(value).toBeGreaterThan(0);
    }
  });

  it('derives the outbound User-Agent from the package identity', () => {
    expect(FETCH.userAgent).toMatch(/^magiclane-mcp-docs-server\/\d+\.\d+\.\d+/);
  });
});

describe('isAllowedDocUrl', () => {
  it('accepts https URLs on the exact documentation host', () => {
    expect(isAllowedDocUrl(`https://${DOCS.host}/docs/x.md`)).toBe(true);
  });

  it('rejects cleartext http, other subdomains, lookalikes, and junk', () => {
    expect(isAllowedDocUrl(`http://${DOCS.host}/docs/x.md`)).toBe(false);
    expect(isAllowedDocUrl('https://staging.magiclane.com/docs/x.md')).toBe(false);
    expect(isAllowedDocUrl('https://www.magiclane.com/docs/x.md')).toBe(false);
    expect(isAllowedDocUrl('https://evilmagiclane.com/docs/x.md')).toBe(false);
    expect(isAllowedDocUrl('https://example.com/x')).toBe(false);
    expect(isAllowedDocUrl('not a url')).toBe(false);
  });
});
