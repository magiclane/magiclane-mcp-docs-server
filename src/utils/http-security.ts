/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure helpers for the HTTP transport's request-validation layer: DNS-rebinding
 * (Host header) protection, CORS origin policy, and proxy-aware client-IP
 * resolution. Kept side-effect free so they can be unit-tested directly.
 */

import { isIP } from 'node:net';

/** Loopback host names always accepted regardless of configuration. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Bind addresses that don't identify a routable Host header value. */
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '[::]', '']);

/**
 * Build the set of acceptable Host header values (lowercased): loopback names,
 * the concrete bind address when it is routable, and any explicitly configured
 * extra hosts — each accepted both bare and with the listen port appended.
 */
export function buildAllowedHosts(host: string, port: number, extra: string[]): Set<string> {
  const allowed = new Set<string>();
  const add = (h: string): void => {
    let v = h.trim().toLowerCase();
    if (!v) return;
    // A bare IPv6 literal (more than one colon, no brackets) is sent by
    // clients in brackets: "[2001:db8::1]" and "[2001:db8::1]:3000".
    if (!v.startsWith('[') && (v.match(/:/g) ?? []).length > 1) v = `[${v}]`;
    allowed.add(v);
    if (!/:\d+$/.test(v) || v.endsWith(']')) {
      // Bare: with the listen port, and with the default ports a client
      // reaching it through a proxy may name.
      for (const p of [port, 80, 443]) allowed.add(`${v}:${p}`);
    } else if (/:(?:80|443)$/.test(v)) {
      // With a default port: clients and proxies (nginx's $host) send it bare.
      allowed.add(v.replace(/:\d+$/, ''));
    }
  };
  for (const h of LOOPBACK_HOSTS) add(h);
  if (!WILDCARD_BINDS.has(host.trim().toLowerCase())) add(host);
  for (const h of extra) add(h);
  return allowed;
}

/**
 * The host part of a Host header: strips a trailing `:port`, keeps IPv6
 * brackets. Anything after the closing bracket other than `:port` leaves the
 * header whole, so "[::1]evil.example" is not taken for "[::1]".
 */
function hostNameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    if (end === -1 || !/^(?::\d+)?$/.test(hostHeader.slice(end + 1))) return hostHeader;
    return hostHeader.slice(0, end + 1);
  }
  return hostHeader.replace(/:\d+$/, '');
}

/**
 * Validate a request's Host header against the allowlist. When protection is
 * disabled every host passes; when enabled, a missing Host is rejected (HTTP/1.1
 * requires one, and its absence is a hallmark of a crafted request). Loopback
 * names are accepted on ANY port, so a container published as `-p 8080:3000`
 * and reached as `localhost:8080` works without configuration.
 */
export function isHostAllowed(
  hostHeader: string | undefined,
  allowed: Set<string>,
  protectionEnabled: boolean
): boolean {
  if (!protectionEnabled) return true;
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  return allowed.has(host) || LOOPBACK_HOSTS.includes(hostNameOf(host));
}

/** The 403 text for a rejected Host, naming the value so the fix is obvious. */
export function hostRejectionMessage(hostHeader: string | undefined): string {
  const shown = hostHeader === undefined ? '(missing)' : JSON.stringify(hostHeader.slice(0, 120));
  return `Forbidden: Host header ${shown} is not allowed. Add it to MCP_ALLOWED_HOSTS or connect via localhost.`;
}

/** Parsed CORS allow-origin policy. */
export interface CorsPolicy {
  /** `*` was configured: any origin may read responses. */
  allowAll: boolean;
  /** Explicit origin allowlist (used when not allowAll). */
  origins: string[];
}

/**
 * An origin as browsers send it: scheme and host in lower case, no default
 * port, no trailing slash — so "HTTPS://App.example:443/" matches the
 * "https://app.example" a browser sends. A value that is not a URL ("null")
 * is kept as written, in lower case.
 */
export function normalizeOrigin(origin: string): string {
  const value = origin.trim();
  try {
    const { origin: normalized } = new URL(value);
    if (normalized !== 'null') return normalized;
  } catch {
    // Not a URL: compared as written.
  }
  return value.toLowerCase();
}

/** Parse the raw MCP_CORS_ORIGIN value into a policy. Empty means "no origin allowed". */
export function parseCorsPolicy(raw: string): CorsPolicy {
  const trimmed = raw.trim();
  if (trimmed === '*') return { allowAll: true, origins: [] };
  const origins = [
    ...new Set(
      trimmed
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0)
        .map(normalizeOrigin)
    ),
  ];
  return { allowAll: false, origins };
}

/** Whether a request's Origin header is permitted by the policy. */
export function isOriginAllowed(originHeader: string | undefined, policy: CorsPolicy): boolean {
  if (policy.allowAll) return true;
  if (!originHeader) return true; // Non-browser clients send no Origin.
  return policy.origins.includes(normalizeOrigin(originHeader));
}

/** The 403 text for a refused Origin, naming the value so the fix is obvious. */
export function originRejectionMessage(originHeader: string): string {
  return `Forbidden: origin ${JSON.stringify(originHeader.slice(0, 120))} is not allowed. Add it to MCP_CORS_ORIGIN.`;
}

/**
 * The `Access-Control-Allow-Origin` value to send, or undefined to send none.
 * `*` when allowAll; the echoed origin when it is on the allowlist; otherwise
 * nothing, so a disallowed browser origin cannot read the response.
 */
export function resolveCorsAllowOrigin(originHeader: string | undefined, policy: CorsPolicy): string | undefined {
  if (policy.allowAll) return '*';
  if (originHeader && policy.origins.includes(normalizeOrigin(originHeader))) return originHeader;
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Client IP                                                                   */
/* -------------------------------------------------------------------------- */

/** An address or CIDR range that is allowed to set X-Forwarded-For. */
export interface TrustedProxy {
  bits: 32 | 128;
  network: bigint;
  prefix: number;
}

/** Numeric form of an IP: IPv4 as 32 bits, IPv6 as 128; IPv4-mapped IPv6 folds to IPv4. */
export function ipToNumber(ip: string): { bits: 32 | 128; value: bigint } | undefined {
  const text = ip
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '');
  const mapped = text.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const candidate = mapped ? (mapped[1] as string) : text;
  const kind = isIP(candidate);
  if (kind === 4) {
    const value = candidate.split('.').reduce((acc, part) => (acc << 8n) + BigInt(part), 0n);
    return { bits: 32, value };
  }
  if (kind !== 6) return undefined;
  // Expand "::" and an embedded IPv4 tail into eight 16-bit groups.
  let groups = candidate.split('::');
  const expand = (part: string): string[] => {
    if (part === '') return [];
    const out: string[] = [];
    for (const g of part.split(':')) {
      if (g.includes('.')) {
        const v4 = ipToNumber(g) as { value: bigint };
        out.push((v4.value >> 16n).toString(16), (v4.value & 0xffffn).toString(16));
      } else out.push(g);
    }
    return out;
  };
  const head = expand(groups[0] as string);
  const tail = groups.length > 1 ? expand(groups[1] as string) : [];
  const fill = new Array(8 - head.length - tail.length).fill('0') as string[];
  groups = [...head, ...fill, ...tail];
  const value = groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n);
  return { bits: 128, value };
}

/**
 * Parse MCP_TRUSTED_PROXIES entries ("10.0.0.5", "10.0.0.0/8", "fd00::/8").
 * Entries that are not an address with an optional prefix of 1 to 3 digits
 * are dropped — an empty prefix ("10.0.0.5/", which Number() would read as
 * /0 and so trust every address), a second slash, letters — so a typo cannot
 * widen trust. Trusting every address takes an explicit "/0".
 */
export function parseTrustedProxies(entries: string[]): TrustedProxy[] {
  const proxies: TrustedProxy[] = [];
  for (const entry of entries) {
    const parts = entry.trim().split('/');
    if (parts.length > 2) continue;
    const [address, prefixText] = parts as [string, string | undefined];
    const parsed = ipToNumber(address);
    if (!parsed) continue;
    if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) continue;
    const prefix = prefixText === undefined ? parsed.bits : Number(prefixText);
    if (prefix > parsed.bits) continue;
    const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(parsed.bits - prefix);
    proxies.push({ bits: parsed.bits, network: parsed.value & mask, prefix });
  }
  return proxies;
}

/**
 * A trusted proxy as parsed, for the start-up log: the network address with
 * its prefix ("10.9.0.0/16" for an entry typed as 10.9.9.9/16), or the single
 * address alone; IPv6 in its canonical compressed form, an IPv4-mapped IPv6
 * entry as the IPv4 address it is kept as.
 */
export function describeTrustedProxy(proxy: TrustedProxy): string {
  let address: string;
  if (proxy.bits === 32) {
    address = [24, 16, 8, 0].map((shift) => Number((proxy.network >> BigInt(shift)) & 0xffn)).join('.');
  } else {
    const groups = Array.from({ length: 8 }, (_, i) =>
      ((proxy.network >> BigInt(112 - 16 * i)) & 0xffffn).toString(16)
    );
    // The URL parser serializes an IPv6 host in the canonical form (RFC 5952): lower case, the longest run of zeros as "::".
    address = new URL(`http://[${groups.join(':')}]/`).hostname.slice(1, -1);
  }
  return proxy.prefix === proxy.bits ? address : `${address}/${proxy.prefix}`;
}

/** Whether the connection's peer is one of the configured proxies. */
export function isTrustedProxy(remoteAddress: string | undefined, proxies: TrustedProxy[]): boolean {
  if (!remoteAddress || proxies.length === 0) return false;
  const parsed = ipToNumber(remoteAddress);
  if (!parsed) return false;
  return proxies.some((p) => {
    if (p.bits !== parsed.bits) return false;
    const mask = p.prefix === 0 ? 0n : ((1n << BigInt(p.prefix)) - 1n) << BigInt(p.bits - p.prefix);
    return (parsed.value & mask) === p.network;
  });
}

/**
 * Resolve the client IP used for rate limiting. The socket address is
 * authoritative unless the connection comes from a configured trusted proxy
 * AND `hops` is positive; then the client is the entry `hops` from the right
 * of X-Forwarded-For (each proxy appends the address it saw). An entry that
 * is not an IP address, or a missing header, falls back to the socket.
 */
export function clientIpFrom(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  hops: number,
  proxies: TrustedProxy[]
): string {
  const socket = normalizeIp(remoteAddress ?? 'unknown');
  if (hops <= 0 || !isTrustedProxy(remoteAddress, proxies)) return socket;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  if (!header) return socket;
  const parts = header
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return socket;
  const chosen = normalizeIp(parts[Math.max(0, parts.length - hops)] as string);
  return chosen.length <= MAX_IP_LENGTH && isIP(chosen) ? chosen : socket;
}

/** The longest textual IP address (an IPv6 address with an embedded IPv4 one). */
const MAX_IP_LENGTH = 45;

/**
 * One spelling per address, so it makes one rate-limit key: the zone of a
 * link-local address is dropped ("fe80::1%eth0", and a zone of any length,
 * is "fe80::1"), and an IPv4-mapped IPv6 address is its IPv4 address
 * ("::ffff:203.0.113.7" is "203.0.113.7").
 */
export function normalizeIp(ip: string): string {
  const zone = ip.indexOf('%');
  const bare = zone === -1 ? ip : ip.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  return mapped ? (mapped[1] as string) : bare;
}

/**
 * The bucket an address is rate-limited under: the address itself for IPv4,
 * the /64 for IPv6 (one subscriber usually controls a whole /64, so counting
 * per address would let it rotate out of any limit).
 */
export function rateLimitKey(ip: string): string {
  const parsed = ipToNumber(ip);
  if (!parsed || parsed.bits === 32) return ip;
  return `${(parsed.value >> 64n).toString(16)}::/64`;
}
