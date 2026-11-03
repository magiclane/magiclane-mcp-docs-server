/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  buildAllowedHosts,
  clientIpFrom,
  describeTrustedProxy,
  hostRejectionMessage,
  ipToNumber,
  isHostAllowed,
  isOriginAllowed,
  isTrustedProxy,
  originRejectionMessage,
  parseCorsPolicy,
  parseTrustedProxies,
  rateLimitKey,
  resolveCorsAllowOrigin,
  normalizeIp,
} from '../../src/utils/http-security.js';

describe('buildAllowedHosts', () => {
  it('always includes loopback names, bare and with the port', () => {
    const hosts = buildAllowedHosts('127.0.0.1', 3000, []);
    for (const h of ['localhost', 'localhost:3000', '127.0.0.1', '127.0.0.1:3000', '[::1]', '[::1]:3000']) {
      expect(hosts.has(h)).toBe(true);
    }
  });

  it('adds a routable bind address but skips wildcard binds', () => {
    expect(buildAllowedHosts('docs.example.com', 8080, []).has('docs.example.com:8080')).toBe(true);
    expect(buildAllowedHosts('0.0.0.0', 3000, []).has('0.0.0.0')).toBe(false);
    expect(buildAllowedHosts('::', 3000, []).has('::')).toBe(false);
    expect(buildAllowedHosts('', 3000, []).has('')).toBe(false);
  });

  it('accepts an IPv6 bind address as clients send it: in brackets, bare and with the port', () => {
    const hosts = buildAllowedHosts('2001:db8::1', 3000, ['fd00::2', '[fd00::3]:9000']);
    for (const h of ['[2001:db8::1]', '[2001:db8::1]:3000', '[fd00::2]', '[fd00::2]:3000', '[fd00::3]:9000']) {
      expect(hosts.has(h), h).toBe(true);
    }
    expect(hosts.has('2001:db8::1')).toBe(false);
    expect(hosts.has('[fd00::3]:9000:3000')).toBe(false);
    expect(isHostAllowed('[2001:db8::1]:3000', hosts, true)).toBe(true);
  });

  it('adds configured extra hosts, not double-appending a port they already carry', () => {
    const hosts = buildAllowedHosts('127.0.0.1', 3000, ['proxy.example.com', 'other.example.com:9000', '  ']);
    expect(hosts.has('proxy.example.com')).toBe(true);
    expect(hosts.has('proxy.example.com:3000')).toBe(true);
    expect(hosts.has('other.example.com:9000')).toBe(true);
    expect(hosts.has('other.example.com:9000:3000')).toBe(false);
  });

  it('accepts a host with and without a default port, as proxies and HTTPS clients send it', () => {
    const hosts = buildAllowedHosts('127.0.0.1', 3000, ['docs.example.com:443', 'plain.example.com', 'web.example:80']);
    for (const h of [
      'docs.example.com',
      'docs.example.com:443',
      'plain.example.com:443',
      'plain.example.com:80',
      'web.example',
    ])
      expect(hosts.has(h), h).toBe(true);
    expect(hosts.has('docs.example.com:80')).toBe(false);
  });
});

describe('isHostAllowed', () => {
  const allowed = buildAllowedHosts('127.0.0.1', 3000, []);

  it('passes everything when protection is disabled', () => {
    expect(isHostAllowed('attacker.example', allowed, false)).toBe(true);
    expect(isHostAllowed(undefined, allowed, false)).toBe(true);
  });

  it('rejects a missing or unlisted Host when protection is enabled', () => {
    expect(isHostAllowed(undefined, allowed, true)).toBe(false);
    expect(isHostAllowed('attacker.example', allowed, true)).toBe(false);
  });

  it('accepts an allowlisted Host case-insensitively', () => {
    expect(isHostAllowed('LOCALHOST:3000', allowed, true)).toBe(true);
    expect(isHostAllowed('127.0.0.1:3000', allowed, true)).toBe(true);
  });

  it('accepts loopback on any port (published container ports), but not other hosts on the listen port', () => {
    expect(isHostAllowed('localhost:8080', allowed, true)).toBe(true);
    expect(isHostAllowed('127.0.0.1:65000', allowed, true)).toBe(true);
    expect(isHostAllowed('[::1]:8080', allowed, true)).toBe(true);
    expect(isHostAllowed('[::1', allowed, true)).toBe(false);
    expect(isHostAllowed('[::1]', allowed, true)).toBe(true);
    // Only :port may follow the bracket.
    expect(isHostAllowed('[::1]evil.example', allowed, true)).toBe(false);
    expect(isHostAllowed('[::1]:80evil', allowed, true)).toBe(false);
    expect(isHostAllowed('evil.example:3000', allowed, true)).toBe(false);
  });
});

describe('hostRejectionMessage', () => {
  it('names the offending host, truncated, and says what to do', () => {
    expect(hostRejectionMessage(undefined)).toContain('(missing)');
    const message = hostRejectionMessage(`evil.example${'x'.repeat(200)}`);
    expect(message).toContain('"evil.example');
    expect(message.length).toBeLessThan(220);
    expect(message).toContain('MCP_ALLOWED_HOSTS');
  });
});

describe('parseCorsPolicy', () => {
  it('treats * as allow-all', () => {
    expect(parseCorsPolicy('*')).toEqual({ allowAll: true, origins: [] });
  });

  it('parses a de-duplicated, trimmed origin list', () => {
    expect(parseCorsPolicy(' https://a.example , https://b.example , https://a.example ')).toEqual({
      allowAll: false,
      origins: ['https://a.example', 'https://b.example'],
    });
  });

  it('normalizes origins as browsers send them: case, trailing slash, default port', () => {
    expect(parseCorsPolicy('HTTP://LocalHost:5173/, https://app.example:443, null').origins).toEqual([
      'http://localhost:5173',
      'https://app.example',
      'null',
    ]);
    const policy = parseCorsPolicy('http://localhost:5173/');
    expect(isOriginAllowed('http://localhost:5173', policy)).toBe(true);
    expect(resolveCorsAllowOrigin('http://localhost:5173', policy)).toBe('http://localhost:5173');
    expect(originRejectionMessage('https://evil.example')).toContain('"https://evil.example"');
  });

  it('treats empty as no origins allowed', () => {
    expect(parseCorsPolicy('')).toEqual({ allowAll: false, origins: [] });
  });
});

describe('isOriginAllowed', () => {
  it('allows any origin under allow-all', () => {
    expect(isOriginAllowed('https://anything.example', { allowAll: true, origins: [] })).toBe(true);
  });

  it('allows requests without an Origin (non-browser clients)', () => {
    expect(isOriginAllowed(undefined, { allowAll: false, origins: [] })).toBe(true);
  });

  it('allows a listed origin and rejects an unlisted one', () => {
    const policy = { allowAll: false, origins: ['https://ok.example'] };
    expect(isOriginAllowed('https://ok.example', policy)).toBe(true);
    expect(isOriginAllowed('https://evil.example', policy)).toBe(false);
  });
});

describe('resolveCorsAllowOrigin', () => {
  it('returns * under allow-all', () => {
    expect(resolveCorsAllowOrigin('https://x.example', { allowAll: true, origins: [] })).toBe('*');
  });

  it('echoes a listed origin', () => {
    expect(resolveCorsAllowOrigin('https://ok.example', { allowAll: false, origins: ['https://ok.example'] })).toBe(
      'https://ok.example'
    );
  });

  it('returns undefined for an unlisted or absent origin', () => {
    const policy = { allowAll: false, origins: ['https://ok.example'] };
    expect(resolveCorsAllowOrigin('https://evil.example', policy)).toBeUndefined();
    expect(resolveCorsAllowOrigin(undefined, policy)).toBeUndefined();
  });
});

describe('ipToNumber', () => {
  it('parses IPv4, IPv6 (compressed, bracketed, zoned, IPv4-mapped) and rejects junk', () => {
    expect(ipToNumber('10.0.0.1')).toEqual({ bits: 32, value: 0x0a000001n });
    expect(ipToNumber('::1')).toEqual({ bits: 128, value: 1n });
    expect(ipToNumber('[fe80::1%eth0]')).toEqual({ bits: 128, value: (0xfe80n << 112n) + 1n });
    expect(ipToNumber('::ffff:10.0.0.1')).toEqual({ bits: 32, value: 0x0a000001n });
    expect(ipToNumber('2001:db8::192.0.2.1')?.value).toBe((0x20010db8n << 96n) + 0xc0000201n);
    expect(ipToNumber('2001:db8:1:2:3:4:5:6')?.bits).toBe(128);
    expect(ipToNumber('not-an-ip')).toBeUndefined();
    expect(ipToNumber('')).toBeUndefined();
  });
});

describe('parseTrustedProxies / isTrustedProxy', () => {
  const proxies = parseTrustedProxies([
    '10.0.0.5',
    '192.168.0.0/16',
    'fd00::/8',
    'garbage',
    '10.0.0.0/33',
    '::/0',
    // A typo never widens trust: an empty prefix is not /0, nor is a second slash or a sign.
    '10.9.9.9/',
    '10.9.9.9//24',
    'fd00::5/',
    '10.0.0.0/+8',
    '10.0.0.0/ 8',
  ]);

  it('keeps only valid addresses and ranges', () => {
    expect(proxies).toHaveLength(4);
  });

  it('matches single addresses, IPv4 ranges and IPv6 ranges', () => {
    expect(isTrustedProxy('10.0.0.5', proxies)).toBe(true);
    expect(isTrustedProxy('10.0.0.6', proxies)).toBe(false);
    expect(isTrustedProxy('192.168.44.1', proxies)).toBe(true);
    expect(isTrustedProxy('::ffff:192.168.44.1', proxies)).toBe(true);
    expect(isTrustedProxy('fd12::1', proxies)).toBe(true);
    expect(isTrustedProxy('2001:db8::1', proxies)).toBe(true); // ::/0 matches every IPv6
    expect(isTrustedProxy('junk', proxies)).toBe(false);
    expect(isTrustedProxy(undefined, proxies)).toBe(false);
    expect(isTrustedProxy('10.0.0.5', [])).toBe(false);
  });

  it('matches a /0 IPv4 range too', () => {
    expect(isTrustedProxy('8.8.8.8', parseTrustedProxies(['0.0.0.0/0']))).toBe(true);
  });
});

describe('describeTrustedProxy', () => {
  it('shows the network as parsed, not the entry as typed', () => {
    const shown = (entry: string): string => describeTrustedProxy(parseTrustedProxies([entry])[0]!);
    expect(shown('10.9.9.9/16')).toBe('10.9.0.0/16');
    expect(shown('10.9.9.9')).toBe('10.9.9.9');
    expect(shown('10.9.9.9/32')).toBe('10.9.9.9');
    expect(shown('0.0.0.0/0')).toBe('0.0.0.0/0');
    expect(shown('fd00:1234::5/8')).toBe('fd00::/8');
    expect(shown('[fe80::1%eth0]')).toBe('fe80::1');
    expect(shown('2001:DB8:0:0:1:0:0:0/128')).toBe('2001:db8:0:0:1::');
    expect(shown('::/0')).toBe('::/0');
    // An IPv4-mapped IPv6 entry is kept as the IPv4 address it names.
    expect(shown('::ffff:10.9.9.9')).toBe('10.9.9.9');
  });
});

describe('clientIpFrom', () => {
  const proxies = parseTrustedProxies(['10.0.0.1']);

  it('uses the socket address when no proxies are trusted or hops is zero', () => {
    expect(clientIpFrom('1.2.3.4', '5.6.7.8', 0, proxies)).toBe('1.2.3.4');
    expect(clientIpFrom('1.2.3.4', '5.6.7.8', 1, [])).toBe('1.2.3.4');
  });

  it('ignores X-Forwarded-For from a peer that is not a trusted proxy', () => {
    expect(clientIpFrom('9.9.9.9', '5.6.7.8', 1, proxies)).toBe('9.9.9.9');
  });

  it('falls back to "unknown" when the socket address is missing', () => {
    expect(clientIpFrom(undefined, undefined, 0, proxies)).toBe('unknown');
  });

  it('reads the client entry from X-Forwarded-For by hop count, from a trusted proxy', () => {
    expect(clientIpFrom('10.0.0.1', '5.6.7.8, 7.7.7.7', 1, proxies)).toBe('7.7.7.7');
    expect(clientIpFrom('10.0.0.1', '5.6.7.8, 7.7.7.7, 8.8.8.8', 2, proxies)).toBe('7.7.7.7');
    expect(clientIpFrom('10.0.0.1', '5.6.7.8', 1, proxies)).toBe('5.6.7.8');
  });

  it('joins a header given as an array and clamps to the first entry', () => {
    expect(clientIpFrom('10.0.0.1', ['1.1.1.1', '2.2.2.2'], 1, proxies)).toBe('2.2.2.2');
    expect(clientIpFrom('10.0.0.1', '3.3.3.3', 5, proxies)).toBe('3.3.3.3');
  });

  it('falls back to the socket when the header is absent, empty, or not an IP', () => {
    expect(clientIpFrom('10.0.0.1', undefined, 1, proxies)).toBe('10.0.0.1');
    expect(clientIpFrom('10.0.0.1', '  ,  ', 1, proxies)).toBe('10.0.0.1');
    expect(clientIpFrom('10.0.0.1', 'client-name', 1, proxies)).toBe('10.0.0.1');
  });
});

describe('rateLimitKey', () => {
  it('keys IPv4 by address and IPv6 by /64', () => {
    expect(rateLimitKey('1.2.3.4')).toBe('1.2.3.4');
    expect(rateLimitKey('::ffff:1.2.3.4')).toBe('::ffff:1.2.3.4');
    expect(rateLimitKey('2001:db8:1:2:aaaa::1')).toBe(rateLimitKey('2001:db8:1:2:bbbb::2'));
    expect(rateLimitKey('2001:db8:1:2::1')).not.toBe(rateLimitKey('2001:db8:1:3::1'));
    expect(rateLimitKey('unknown')).toBe('unknown');
  });
});

describe('normalizeIp', () => {
  it('spells each address one way: no zone, IPv4-mapped as IPv4', () => {
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp(`fe80::1%${'z'.repeat(15_000)}`)).toBe('fe80::1');
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('::FFFF:203.0.113.7%x')).toBe('203.0.113.7');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIp('unknown')).toBe('unknown');
  });

  it('keys a forwarded address with a long zone, or a mapped one, like the plain address', () => {
    const proxies = parseTrustedProxies(['127.0.0.1']);
    expect(clientIpFrom('127.0.0.1', `::ffff:203.0.113.7%${'z'.repeat(15_000)}`, 1, proxies)).toBe('203.0.113.7');
    expect(clientIpFrom('::ffff:10.1.2.3', undefined, 0, [])).toBe('10.1.2.3');
  });
});
