/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runtime configuration: everything this server reads from the environment,
 * parsed once into one typed dictionary. Values are merged over the defaults
 * in {@link ENV_DEFAULTS}, so an unset or invalid variable always falls back
 * to a known-good value rather than failing at startup.
 *
 * Add new variables HERE, never with a bare `process.env` read in a module —
 * `readEnv(source)` takes an injectable source, so it stays unit-testable
 * without module resets.
 */

/* -------------------------------------------------------------------------- */
/* Parsers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Parse a boolean environment flag. Accepts "true", "1", "yes", "on"
 * (case-insensitive); anything else — including unset — is false.
 */
export function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * Parse a boolean flag that defaults to `true` when unset or blank (the
 * inverse of {@link parseBooleanEnv}), for opt-out security switches.
 */
export function parseBooleanEnvDefaultTrue(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return true;
  return parseBooleanEnv(value);
}

/**
 * The MCP endpoint path: must start with "/", must not be one of the probe
 * endpoints, which are always served at /health and /ready, and must hold no
 * "?", "#" or whitespace (a request's query and fragment are not part of the
 * path it is matched by, so such a path could never be reached); anything
 * else falls back.
 */
export function parsePathEnv(value: string | undefined, fallback: string): string {
  const path = value?.trim() ?? '';
  if (!path.startsWith('/') || /[?#\s]/.test(path)) return fallback;
  if (path === '/health' || path === '/ready' || path === '/') return fallback;
  return path;
}

/** The value, or undefined when it is unset or only whitespace. */
function nonBlank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/**
 * Parse a whole-number environment value, written in decimal digits only,
 * falling back to `fallback` when unset, not such a number, or out of range.
 * Digits only: the other spellings Number() reads ("0x2", "1e1", "2.0") are
 * not a whole number as written, and a mistyped "1e1" must not quietly mean
 * ten trusted proxy hops.
 */
export function parseIntEnv(value: string | undefined, fallback: number, min = 1, max = 65_535): number {
  const digits = value?.trim() ?? '';
  if (!/^\d+$/.test(digits)) return fallback;
  const parsed = Number(digits);
  return parsed < min || parsed > max ? fallback : parsed;
}

/**
 * Parse a comma-separated environment list into trimmed, de-duplicated,
 * non-empty values. Unset or all-blank yields an empty array.
 */
export function parseListEnv(value: string | undefined): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
    ),
  ];
}

/* -------------------------------------------------------------------------- */
/* Shape                                                                       */
/* -------------------------------------------------------------------------- */

/** HTTP transport settings, all overridable from the environment. */
interface HttpEnvConfig {
  /** Listen port — PORT / MCP_HTTP_PORT (default 3000). */
  port: number;
  /** Bind address — MCP_HTTP_HOST (default 127.0.0.1). */
  host: string;
  /** MCP endpoint path — MCP_HTTP_PATH (default /mcp). */
  path: string;
  /**
   * CORS allow-origin policy — MCP_CORS_ORIGIN. A comma-separated allowlist of
   * origins, or `*` to allow any. Empty (the default) sends no CORS headers, so
   * no browser origin can read responses; non-browser MCP clients are
   * unaffected. Set this to your web client's origin to allow it.
   */
  corsOrigin: string;
  /**
   * Extra Host header values accepted for DNS-rebinding protection —
   * MCP_ALLOWED_HOSTS. Localhost and the bind address are always accepted;
   * add the public hostname here when serving behind a proxy.
   */
  allowedHosts: string[];
  /** Validate the Host header against the allowlist — MCP_DNS_REBINDING_PROTECTION (default true). */
  dnsRebindingProtection: boolean;
  /**
   * Number of trusted reverse-proxy hops in front of the server —
   * TRUSTED_PROXY_HOPS (default 0). When > 0 AND the connection comes from one
   * of `trustedProxies`, the client IP for rate limiting is read from
   * X-Forwarded-For instead of the socket address.
   */
  trustedProxyHops: number;
  /**
   * Addresses or CIDR ranges of the reverse proxies allowed to set
   * X-Forwarded-For — MCP_TRUSTED_PROXIES (default: none). Without this list
   * the header is ignored, because any client that reaches the port directly
   * could otherwise choose its own rate-limit identity.
   */
  trustedProxies: string[];
}

/** Everything this server reads from the environment, in one typed structure. */
export interface EnvConfig {
  /** VERBOSE — log tool invocations to stderr (default false). */
  verbose: boolean;
  /** Settings that apply only to the Streamable HTTP transport. */
  http: HttpEnvConfig;
  /**
   * Variables that were set to a value this server cannot use, so the default
   * is in effect — each as one line saying so, which the HTTP entry point logs
   * at start (for now: a TRUSTED_PROXY_HOPS that is not a whole number from 0
   * to 100, which silently reading as 0 would hide).
   */
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/* Defaults and merge                                                          */
/* -------------------------------------------------------------------------- */

/** Defaults applied when a variable is unset or invalid. */
export const ENV_DEFAULTS = {
  verbose: false,
  http: {
    port: 3000,
    host: '127.0.0.1',
    path: '/mcp',
    corsOrigin: '',
    allowedHosts: [] as string[],
    dnsRebindingProtection: true,
    trustedProxyHops: 0,
    trustedProxies: [] as string[],
  },
} as const;

/**
 * Build the environment configuration from a variable source (defaults to
 * `process.env`), merging every parsed value over {@link ENV_DEFAULTS}.
 * Pure and injectable, so tests need no module resets.
 */
export function readEnv(source: NodeJS.ProcessEnv = process.env): EnvConfig {
  const warnings: string[] = [];
  const hops = nonBlank(source.TRUSTED_PROXY_HOPS);
  if (hops !== undefined && parseIntEnv(hops, -1, 0, 100) === -1) {
    warnings.push(
      `TRUSTED_PROXY_HOPS ignored (${JSON.stringify(hops.trim())} is not a whole number from 0 to 100): using 0, so X-Forwarded-For is not read`
    );
  }
  return {
    ...ENV_DEFAULTS,
    warnings,
    verbose: parseBooleanEnv(source.VERBOSE),
    http: {
      ...ENV_DEFAULTS.http,
      // A blank MCP_HTTP_PORT (`MCP_HTTP_PORT=` in a .env) counts as unset, so
      // a platform-assigned PORT still wins over the default.
      port: parseIntEnv(nonBlank(source.MCP_HTTP_PORT) ?? source.PORT, ENV_DEFAULTS.http.port),
      host: source.MCP_HTTP_HOST?.trim() || ENV_DEFAULTS.http.host,
      path: parsePathEnv(source.MCP_HTTP_PATH, ENV_DEFAULTS.http.path),
      corsOrigin: source.MCP_CORS_ORIGIN?.trim() ?? ENV_DEFAULTS.http.corsOrigin,
      allowedHosts: parseListEnv(source.MCP_ALLOWED_HOSTS),
      dnsRebindingProtection: parseBooleanEnvDefaultTrue(source.MCP_DNS_REBINDING_PROTECTION),
      trustedProxyHops: parseIntEnv(source.TRUSTED_PROXY_HOPS, ENV_DEFAULTS.http.trustedProxyHops, 0, 100),
      trustedProxies: parseListEnv(source.MCP_TRUSTED_PROXIES),
    },
  };
}

/** The environment as read once at startup. */
export const ENV: EnvConfig = readEnv();

/**
 * Verbose diagnostics (default false). When true, tool invocations are logged
 * to stderr. Set with VERBOSE=true (stdout is reserved for the MCP protocol).
 */
export const VERBOSE = ENV.verbose;
