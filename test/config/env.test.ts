/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  ENV,
  ENV_DEFAULTS,
  parseBooleanEnvDefaultTrue,
  parseIntEnv,
  parseListEnv,
  readEnv,
} from '../../src/config/env.js';

describe('parseListEnv', () => {
  it('splits, trims, drops empties, and de-duplicates', () => {
    expect(parseListEnv('a, b ,, a ,c')).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for unset or blank input', () => {
    expect(parseListEnv(undefined)).toEqual([]);
    expect(parseListEnv('   ')).toEqual([]);
  });
});

describe('parseBooleanEnvDefaultTrue', () => {
  it('defaults to true when unset or blank', () => {
    expect(parseBooleanEnvDefaultTrue(undefined)).toBe(true);
    expect(parseBooleanEnvDefaultTrue('  ')).toBe(true);
  });

  it('honours explicit truthy and falsy values', () => {
    expect(parseBooleanEnvDefaultTrue('false')).toBe(false);
    expect(parseBooleanEnvDefaultTrue('0')).toBe(false);
    expect(parseBooleanEnvDefaultTrue('true')).toBe(true);
  });
});

describe('parseIntEnv', () => {
  it('falls back when unset or empty', () => {
    expect(parseIntEnv(undefined, 3000)).toBe(3000);
    expect(parseIntEnv('', 3000)).toBe(3000);
  });

  it('parses valid integers, trimming whitespace', () => {
    expect(parseIntEnv('8080', 3000)).toBe(8080);
    expect(parseIntEnv(' 8080 ', 3000)).toBe(8080);
  });

  it('falls back on non-numeric, fractional, or out-of-range values', () => {
    expect(parseIntEnv('abc', 3000)).toBe(3000);
    expect(parseIntEnv('80.5', 3000)).toBe(3000);
    expect(parseIntEnv('0', 3000)).toBe(3000);
    expect(parseIntEnv('-1', 3000)).toBe(3000);
    expect(parseIntEnv('70000', 3000)).toBe(3000);
  });

  it('reads decimal digits only, not the other spellings Number() takes', () => {
    for (const spelling of ['0x1F90', '8e3', '8080.0', '+8080', '0b11', '8_080', 'Infinity']) {
      expect(parseIntEnv(spelling, 3000), spelling).toBe(3000);
    }
    expect(parseIntEnv('08080', 3000)).toBe(8080); // leading zeros are still decimal
  });

  it('honours custom bounds', () => {
    expect(parseIntEnv('50', 10, 1, 100)).toBe(50);
    expect(parseIntEnv('500', 10, 1, 100)).toBe(10);
  });
});

describe('readEnv', () => {
  it('returns the documented defaults for an empty environment', () => {
    expect(readEnv({})).toEqual({
      verbose: ENV_DEFAULTS.verbose,
      http: {
        port: ENV_DEFAULTS.http.port,
        host: ENV_DEFAULTS.http.host,
        path: ENV_DEFAULTS.http.path,
        corsOrigin: ENV_DEFAULTS.http.corsOrigin,
        allowedHosts: [],
        dnsRebindingProtection: ENV_DEFAULTS.http.dnsRebindingProtection,
        trustedProxyHops: ENV_DEFAULTS.http.trustedProxyHops,
        trustedProxies: [],
      },
      warnings: [],
    });
  });

  it('reads every supported variable', () => {
    const env = readEnv({
      VERBOSE: 'true',
      MCP_HTTP_PORT: '8080',
      MCP_HTTP_HOST: '0.0.0.0',
      MCP_HTTP_PATH: '/docs-mcp',
      MCP_CORS_ORIGIN: 'https://example.com',
      MCP_ALLOWED_HOSTS: 'docs.example.com, docs.example.com:8080',
      MCP_DNS_REBINDING_PROTECTION: 'false',
      TRUSTED_PROXY_HOPS: '2',
      MCP_TRUSTED_PROXIES: '10.0.0.1, 192.168.0.0/16',
    });
    expect(env).toEqual({
      verbose: true,
      http: {
        port: 8080,
        host: '0.0.0.0',
        path: '/docs-mcp',
        corsOrigin: 'https://example.com',
        allowedHosts: ['docs.example.com', 'docs.example.com:8080'],
        dnsRebindingProtection: false,
        trustedProxyHops: 2,
        trustedProxies: ['10.0.0.1', '192.168.0.0/16'],
      },
      warnings: [],
    });
  });

  it('falls back for an endpoint path without a leading slash, "/", a probe path, or one no request can reach', () => {
    for (const bad of ['mcp', '/health', '/ready', '/', '  ', '/mcp?key=abc', '/mcp#x', '/my mcp'])
      expect(readEnv({ MCP_HTTP_PATH: bad }).http.path, bad).toBe('/mcp');
    expect(readEnv({ MCP_HTTP_PATH: ' /docs-mcp ' }).http.path).toBe('/docs-mcp');
  });

  it('prefers MCP_HTTP_PORT over PORT and accepts PORT alone', () => {
    expect(readEnv({ MCP_HTTP_PORT: '8080', PORT: '9090' }).http.port).toBe(8080);
    expect(readEnv({ PORT: '9090' }).http.port).toBe(9090);
    // `MCP_HTTP_PORT=` copied from a template must not hide the platform's PORT.
    expect(readEnv({ MCP_HTTP_PORT: '', PORT: '9090' }).http.port).toBe(9090);
    expect(readEnv({ MCP_HTTP_PORT: '  ', PORT: '9090' }).http.port).toBe(9090);
  });

  it('falls back to defaults for blank or invalid values', () => {
    const env = readEnv({
      MCP_HTTP_PORT: 'not-a-port',
      MCP_HTTP_HOST: '   ',
      MCP_HTTP_PATH: '',
      TRUSTED_PROXY_HOPS: 'nope',
    });
    expect(env.http.port).toBe(ENV_DEFAULTS.http.port);
    expect(env.http.host).toBe(ENV_DEFAULTS.http.host);
    expect(env.http.path).toBe(ENV_DEFAULTS.http.path);
    expect(env.http.corsOrigin).toBe(ENV_DEFAULTS.http.corsOrigin);
    expect(env.http.allowedHosts).toEqual([]);
    expect(env.http.dnsRebindingProtection).toBe(true);
    expect(env.http.trustedProxyHops).toBe(0);
  });

  it('warns about a TRUSTED_PROXY_HOPS it cannot read, instead of silently taking it for 0', () => {
    for (const bad of ['nope', ' abc ', '1.5', '-1', '101', '0x2', '1e1', '2.0']) {
      const { warnings, http } = readEnv({ TRUSTED_PROXY_HOPS: bad });
      expect(http.trustedProxyHops, bad).toBe(0);
      expect(warnings, bad).toEqual([
        `TRUSTED_PROXY_HOPS ignored (${JSON.stringify(bad.trim())} is not a whole number from 0 to 100): using 0, so X-Forwarded-For is not read`,
      ]);
    }
    // Unset, blank or usable: nothing to say.
    for (const fine of [undefined, '', '  ', '0', '2', ' 100 ']) {
      expect(readEnv({ TRUSTED_PROXY_HOPS: fine }).warnings, String(fine)).toEqual([]);
    }
  });

  it('ignores unknown variables', () => {
    expect(readEnv({ MAGICLANE_API_KEY: 'ignored', SOMETHING_ELSE: 'x' })).toEqual(readEnv({}));
  });

  it('exposes a process-wide ENV snapshot with the same shape', () => {
    expect(ENV).toEqual(readEnv(process.env));
    expect(typeof ENV.verbose).toBe('boolean');
    expect(typeof ENV.http.port).toBe('number');
  });
});
