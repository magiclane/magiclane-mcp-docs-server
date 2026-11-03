/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Streamable HTTP entry point for the Magic Lane MCP Docs Server.
 *
 * Exposes the MCP endpoint at POST {MCP_HTTP_PATH} (default /mcp) using the
 * SDK's StreamableHTTPServerTransport in stateless mode, plus GET /health
 * (liveness) and GET /ready (readiness).
 * All request handling lives in `./http/app.ts`; this file only reads the
 * environment, wires the app to a listener, and handles signals and exit codes.
 *
 * No authentication: the documentation this server exposes is public. Bind to
 * localhost (the default) or put a reverse proxy in front when exposing it.
 *
 * Env overrides:
 *   MCP_HTTP_PORT / PORT          listen port                (default 3000)
 *   MCP_HTTP_HOST                 bind address               (default 127.0.0.1)
 *   MCP_HTTP_PATH                 MCP endpoint path          (default /mcp)
 *   MCP_CORS_ORIGIN               CORS allowlist or *        (default: none)
 *   MCP_ALLOWED_HOSTS             extra allowed Host values  (default: none)
 *   MCP_DNS_REBINDING_PROTECTION  validate Host header       (default true)
 *   MCP_TRUSTED_PROXIES           proxies that may set X-Forwarded-For (default: none)
 *   TRUSTED_PROXY_HOPS            reverse-proxy hop count    (default 0)
 *   VERBOSE                       log tool invocations       (default false)
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer } from './server.js';
import { HTTP } from './config/constants.js';
import { ENV, VERBOSE } from './config/env.js';
import { createHttpApp } from './http/app.js';
import { loadIndex } from './docs/docs-index.js';
import {
  buildAllowedHosts,
  describeTrustedProxy,
  parseCorsPolicy,
  parseTrustedProxies,
} from './utils/http-security.js';

const { port: PORT, host: HOST, path: MCP_PATH } = ENV.http;
const TRUSTED_PROXIES = parseTrustedProxies(ENV.http.trustedProxies);
/** MCP_TRUSTED_PROXIES entries that are not an address or a range: never trusted, and said so at start. */
const IGNORED_PROXIES = ENV.http.trustedProxies.filter((e) => parseTrustedProxies([e]).length === 0);

const app = createHttpApp({
  mcpPath: MCP_PATH,
  allowedHosts: buildAllowedHosts(HOST, PORT, ENV.http.allowedHosts),
  dnsRebindingProtection: ENV.http.dnsRebindingProtection,
  corsPolicy: parseCorsPolicy(ENV.http.corsOrigin),
  trustedProxyHops: ENV.http.trustedProxyHops,
  trustedProxies: TRUSTED_PROXIES,
  limits: HTTP,
  createServer,
});

const sweeper = setInterval(() => app.sweep(), 60_000);
sweeper.unref();

const httpServer = createHttpServer(
  // Checked every second, so unfinished headers get their 408 at 15 s, not anywhere up to 45 s.
  { connectionsCheckingInterval: HTTP.connectionsCheckingIntervalMs },
  app.handler
);
// Slow-loris protection: bound how long a client may take to send headers, a
// whole request, or keep an idle connection open.
httpServer.headersTimeout = HTTP.headersTimeoutMs;
httpServer.requestTimeout = HTTP.requestTimeoutMs;
httpServer.timeout = HTTP.socketIdleTimeoutMs;
httpServer.keepAliveTimeout = HTTP.keepAliveTimeoutMs;

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  // A failed listen (EADDRINUSE, EACCES) must be a failed start, not a silent exit 0.
  console.error(`Cannot start HTTP server on ${HOST}:${PORT}: ${err.message}`);
  process.exit(1);
});

httpServer.listen(PORT, HOST, () => {
  // An IPv6 address is bracketed in a URL.
  const shown = HOST.includes(':') ? `[${HOST}]` : HOST;
  console.log(`Magic Lane MCP Docs Server (Streamable HTTP) listening on http://${shown}:${PORT}${MCP_PATH}`);
  // A setting that could not be used (a mistyped TRUSTED_PROXY_HOPS) is said
  // so, not silently read as its default.
  for (const warning of ENV.warnings) console.error(warning);
  // The networks as parsed ("10.9.0.0/16" for an entry typed as 10.9.9.9/16), not the entries as typed.
  const trusted = [...new Set(TRUSTED_PROXIES.map(describeTrustedProxy))];
  if (trusted.length > 0) {
    // What is in effect: a list is used only with TRUSTED_PROXY_HOPS set.
    console.log(
      ENV.http.trustedProxyHops > 0
        ? `Trusted proxies (may set X-Forwarded-For, ${ENV.http.trustedProxyHops} hop(s)): ${trusted.join(', ')}`
        : `Trusted proxies ignored while TRUSTED_PROXY_HOPS is 0 (X-Forwarded-For is not read): ${trusted.join(', ')}`
    );
  }
  if (IGNORED_PROXIES.length > 0) {
    console.error(`MCP_TRUSTED_PROXIES entries ignored (not an address or a range): ${IGNORED_PROXIES.join(', ')}`);
  }
  // The indexes load at start: /ready answers "starting" (503) until the
  // first one is in, and the first search does not wait for the download.
  void loadIndex();
  console.log(
    VERBOSE ? 'Verbose: on (tool invocations logged to stderr)' : 'Verbose: off (set VERBOSE=true to enable)'
  );
});

function shutdown(): void {
  console.log('Shutting down...');
  clearInterval(sweeper);
  app.close();
  // Calls already running may finish (new ones get 503); the process exits 0
  // once the last connection closes. Connections that go idle meanwhile (a
  // keep-alive client's) are closed as they do, not held until the client
  // leaves. A connection with no call running on it — one that connected and
  // sent nothing, a half-sent request, a body still arriving — would hold the
  // exit for the whole grace period, so as soon as no call is running at all,
  // every connection still open is closed, and the process exits 0 at once.
  // If calls are still running after the grace period, the process exits 1,
  // so a supervisor can tell a cut-short drain from a clean one.
  httpServer.close(() => process.exit(0));
  const drain = (): void => {
    httpServer.closeIdleConnections();
    if (app.stats().servingRequests === 0) httpServer.closeAllConnections();
  };
  drain();
  setInterval(drain, 1_000).unref();
  setTimeout(() => {
    const running = app.stats().servingRequests;
    if (running > 0) {
      console.error(`${running} call(s) still running after ${HTTP.shutdownGraceMs / 1000} s: exiting anyway.`);
      process.exit(1);
    }
    console.log('No call running: closing the connections still open.');
    httpServer.closeAllConnections();
    process.exit(0);
  }, HTTP.shutdownGraceMs).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// A stray rejection from a background task (a transport tearing down after
// the client went away) is logged, not fatal. An uncaught exception means the
// process state is unknown — log it and let the supervisor restart us, rather
// than continuing with requests that may never be answered.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception, exiting:', err);
  process.exit(1);
});
