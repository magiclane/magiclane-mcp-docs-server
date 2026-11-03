# HTTP Server Setup Guide

Run the **Magic Lane MCP Docs Server** over Streamable HTTP instead of stdio —
useful for shared deployments, containers, web-based MCP clients, and the MCP
Inspector's HTTP mode.

## Overview

The HTTP entry point (`dist/docs-server-http.esm.js`, installed as the
`magiclane-mcp-docs-http` command) serves the MCP endpoint at `POST /mcp`
(`MCP_HTTP_PATH`) and a separate `GET /health`. It runs the SDK's
`StreamableHTTPServerTransport` in **stateless** mode: no session ids are
issued, there is no `mcp-session-id` header, no session table, no idle
eviction, and no GET notification stream. Each `POST` gets a fresh
server/transport pair that is closed when the response ends; `initialize` is
answered like any other request, and the tools keep no per-client state, so
clients notice no difference — except that the optional GET notification
stream, which this server never used, is answered `405`.

All request handling lives in `src/http/app.ts` (`createHttpApp`); the entry
point only reads the environment, wires the app to a `node:http` listener,
sets the socket timeouts and handles signals and exit codes.

## Prerequisites

- Node.js 22+
- No API key or account is required — the documentation served is public, and
  the server has no authentication of its own (see Production Deployment).

## Building the Server Locally

```bash
git clone https://github.com/magiclane/magiclane-mcp-docs-server.git
cd magiclane-mcp-docs-server
npm install
npm run build
```

## Configuration

| Variable                       | Default     | Description                                                                                                                                          |
| ------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_HTTP_PORT` / `PORT`       | `3000`      | Listen port; `MCP_HTTP_PORT` wins over `PORT` unless it is empty, invalid values fall back to 3000                                                   |
| `MCP_HTTP_HOST`                | `127.0.0.1` | Bind address (`0.0.0.0` to expose beyond localhost — only behind a reverse proxy)                                                                    |
| `MCP_HTTP_PATH`                | `/mcp`      | MCP endpoint path; must start with `/` and cannot be `/health`, `/ready` or `/` — those fall back to `/mcp`                                          |
| `MCP_CORS_ORIGIN`              | _(empty)_   | CORS allow-origin: comma-separated origin allowlist, or `*`; empty = no browser origin may read responses                                            |
| `MCP_ALLOWED_HOSTS`            | _(empty)_   | Extra `Host` header values accepted by DNS-rebinding protection (loopback names are always accepted, on any port)                                    |
| `MCP_DNS_REBINDING_PROTECTION` | `true`      | Validate the `Host` header against the allowlist. Only `true`/`1`/`yes`/`on` (or unset) enable it — a misspelling such as `enabled` turns it **off** |
| `MCP_TRUSTED_PROXIES`          | _(empty)_   | Comma-separated IPs or CIDR ranges of the proxies allowed to set `X-Forwarded-For`, e.g. `10.0.0.5, 192.168.0.0/16, fd00::/8`                        |
| `TRUSTED_PROXY_HOPS`           | `0`         | Number of trusted proxy hops; `X-Forwarded-For` is honoured only when `> 0` **and** the connection comes from an address in `MCP_TRUSTED_PROXIES`    |
| `VERBOSE`                      | `false`     | When `true`, log each tool invocation (tool name) to stderr                                                                                          |

### Built-in limits

Fixed in `src/config/constants.ts` (`HTTP` for the transport, `FETCH` for the outbound fetches) and `src/http/app.ts` (the stalled-body and refusal-memo timings):

| Protection                        | Limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Response                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Request body size                 | 256 KB                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `413`, connection closed                                             |
| Time to receive the whole body    | 15 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `408`, connection closed                                             |
| Request-body bytes in flight      | 16 MB across all connections, 1 MB per client; a body declared under 1 KB (a ping) only counts against its client's share. When a request arrives while half the 16 MB is in use, bodies that have been arriving for over 2 s are cut off (`408`); when a request's declared body would not fit what is left of the budget — or, for one that declares no length, as soon as its bytes overrun it — the bodies of clients holding more than an equal share of it (the budget split among the clients with bodies in flight and the newcomer) are cut, biggest holder first, until the request fits, so slow or endlessly renewed bodies cannot keep others out, whether they fill the budget or hold it just short of full. A body declared over the 256 KB cap is refused with `413` before it can cut anyone                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `503` + `Retry-After: 1` (closed when a body overruns the share)     |
| MCP requests executed at once     | 32, at most 4 per client; others wait up to 10 s in a queue of 64 (at most 4 per client)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `503` + `Retry-After: 1` when the queue is full or the wait runs out |
| Requests that never wait          | `initialize`, `ping`, `tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`, notifications; `list_docs` once the index it lists is in memory (every index when it names no source), `find_across_sdks` once every index and every page-contents file (`llms-full.txt`) is in memory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | —                                                                    |
| Batched JSON-RPC arrays           | not accepted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `400`                                                                |
| Requests per client               | 300 per 60 s, every route but `OPTIONS`; `/health` and `/ready` count in a second window of their own per client, so a probe is not refused when the client is busy and probing does not use up its calls; a `search_docs` or `find_across_sdks` call counts 5 — refused, it keeps only the 1 counted on arrival                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `429` + `Retry-After` = seconds left in the window                   |
| Uncached page fetches per client  | 120 per 60 s, reserved when a fetch is queued; a fetch that never starts gives it back (refused as busy, abandoned while queued, or given its slot with under 1 s of its call's time left and so not sent), one that is sent counts whether or not the call stays for the answer; cached pages and the shared index/full-text files are free, as MCP resources too                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | tool error naming the wait                                           |
| Outbound fetches to the docs site | 6 at once; a client starts at most 4 page fetches while another client waits, and alone uses all but one slot (not while a fetch has been running over 5 s) — a fifth it started while alone runs on to its end, and does not count for a client running nothing yet, which gets a seventh slot the moment it asks (one extra slot: a client borrows one at most); the last free slot is kept for a client running nothing yet while fewer than three clients run pages, so two clients can never hold every slot between them, and also while a fetch has been running over 5 s, or one timed out waiting for an answer within the last 60 s (the site hangs; a page answered meanwhile ends the `/health` reason, not this rule — the clients whose pages hung have their next pages queued), so clients whose pages hang cannot hold every slot past their first round (three can, for that round: see Troubleshooting); the health probes' reloads of failed files run 2 at a time, after the calls' fetches, leaving a slot free — one that has had no answer for 5 s hands its turn to the next file and runs on beside the 6 slots (2 such at most), so files that hang keep the others waiting 5 s, not 20 s; a file whose last download hung (was sent and got no answer) after the others, and among those a file whose download never got going first, then the one that started longest ago, so a file that keeps hanging does not keep the others waiting; each waits up to 30 s for its turn and takes at most 50 s in all — and a call that needs a file being reloaded raises that reload to its own priority; 64 page fetches may wait, at most 16 per client; the index files go first; each fetch waits at most 20 s for a slot and 20 s for an answer, and takes at most 30 s from being queued, its one retry included (a 5xx or network error after a quick attempt; never a timeout) — the pages of a `read_docs_batch` call of more than 4 pages (6 on stdio) wait 20 s per 4 pages (6 on stdio) for a slot and end at most 50 s after being queued — over HTTP, at the end of the call's request budget when that is later, as under load a batch's last pages get their turn late while the call still has time for them; a smaller batch has the 30 s of one page; and a call stops waiting for its pages at the latest 55 s after its request arrived (the request budget), the waits for the body and a request slot included, so the answer comes inside the 60 s most MCP clients wait — and none of its pages is sent with less than 1 s of that left, so the slots its running pages free at the deadline do not go to its queued ones only to be aborted at once | tool error "busy, retry"                                             |
| `node:http` socket timeouts       | headers 15 s, request 60 s (both checked every second), idle socket 120 s, keep-alive 5 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | connection closed                                                    |

A "client" is the client address (IPv6 per `/64`, since one subscriber usually
controls a whole `/64`; behind a proxy, see Trusted proxies below): every limit
that protects the whole process has a per-client share, so one client cannot
make the server refuse everyone. At most 100,000 clients have a rate-limit
window at once (probes count separately, so a client may hold two); beyond
that, expired windows are dropped (at most once a second) and the oldest
window is evicted for the new client, so a flood of addresses can neither grow
the table without bound nor lock new clients out — at worst a client whose
window was evicted starts a fresh one.
An address is keyed in one spelling: a zone suffix (`fe80::1%eth0`) is dropped
and an IPv4-mapped address (`::ffff:203.0.113.7`) counts as its IPv4 address.
When a client disconnects, the tool work
started for it is cancelled — its queued fetches leave the queue — and its slot
is freed once that work has stopped. Every response the server writes carries
`Cache-Control: no-store` and `X-Content-Type-Options: nosniff` (the SDK
transport sets `Cache-Control: no-cache, no-transform` on the SSE responses it
streams itself). A failed listen (port in use, permission denied) exits with
status 1 instead of a silent exit 0, and an uncaught exception is logged and
exits 1 — run the process under a supervisor (systemd, Docker restart policy)
and let it restart.

### Request validation

The `Host` header is checked against an allowlist to block DNS-rebinding
attacks: loopback names (`localhost`, `127.0.0.1`, `[::1]`) are accepted on
**any** port, the concrete bind address and every `MCP_ALLOWED_HOSTS` entry are
accepted bare and with the listen port (after `[…]` only `:port` may
follow), and anything else is answered `403` with a message that names the
offending value (an HTTP/1.1 request without `Host` is answered `400` by
Node's parser before it gets this far; an HTTP/1.0 request without one gets
the `403`): `Forbidden: Host header "evil.example" is not allowed. Add it to
MCP_ALLOWED_HOSTS or connect via localhost.`

A browser `Origin` is refused with `403` unless it matches `MCP_CORS_ORIGIN`;
non-browser MCP clients send no `Origin` and are unaffected. **Do not set
`MCP_CORS_ORIGIN=*` casually**: the server has no authentication, so a wildcard
lets any web page the user happens to visit call a local instance from their
browser. Allow the specific origin of your web client instead.

### Trusted proxies and the client address

Rate limiting keys off the client address. By default that is the socket
address. When a request arrives from an address in `MCP_TRUSTED_PROXIES` **and**
`TRUSTED_PROXY_HOPS` is greater than 0, the address is taken from
`X-Forwarded-For` instead: the entry `TRUSTED_PROXY_HOPS` from the right (each
proxy appends the address it saw). Entries of `MCP_TRUSTED_PROXIES` that are not
addresses or CIDR ranges are ignored, so a typo cannot widen trust; a chosen
header entry that is not itself an IP address falls back to the socket address.
The start-up log says what is in effect: `Trusted proxies (may set
X-Forwarded-For, N hop(s)): …` listing the networks as parsed (`10.9.0.0/16`
for an entry typed as `10.9.9.9/16`; an IPv4-mapped IPv6 address as its IPv4
address), or `Trusted proxies ignored while TRUSTED_PROXY_HOPS is 0` when the
list was set without the hops; on stderr, the entries it dropped, and a
`TRUSTED_PROXY_HOPS` that is not a whole number from 0 to 100 in decimal digits
(`abc`, `1.5`, and also `1e1`, `0x2` or `2.0`), which is ignored and read as 0.

Behind a reverse proxy, therefore: set `MCP_ALLOWED_HOSTS` to the public
hostname (or the proxy trips the `Host` check with `403`), set
`MCP_TRUSTED_PROXIES` to the proxy's address and `TRUSTED_PROXY_HOPS` to the
number of proxies in the chain. If your proxy already validates `Host`, you may
set `MCP_DNS_REBINDING_PROTECTION=false`.

### Loading a `.env` file

`npm run start:http` does not read `.env`. Copy the template and load it with
Node's native `--env-file` (the project has no `dotenv` dependency):

```bash
cp .env.example .env
node --env-file=.env dist/docs-server-http.esm.js
```

[`.env.example`](https://github.com/magiclane/magiclane-mcp-docs-server/blob/HEAD/.env.example) lists every variable with its default; `.env` is git-ignored.
Values are parsed once into a typed `ENV` structure in `src/config/env.ts`, and
invalid values (e.g. a non-numeric port) fall back to the default rather than
crashing the server.

## Starting the Server

```bash
# Development (from TypeScript sources)
npm run dev:http

# Production (built bundle)
npm run build
npm run start:http            # or: magiclane-mcp-docs-http, once installed

# On a custom port
MCP_HTTP_PORT=8080 npm run start:http

# With verbose tool-invocation logging
VERBOSE=true npm run start:http
```

The startup banner reports the endpoint URL and whether verbose mode is on.
Tool invocations are logged to stderr as `[Magic Lane MCP Docs] tool invoked:
<tool_name>`; accepted truthy values for `VERBOSE` are `true`, `1`, `yes`, `on`
(case-insensitive).

As a service, start the server from a clone (`npm run build`, then
`node dist/docs-server-http.esm.js`), from a global install
once the package is published (`npm install -g @magiclane/mcp-docs-server`,
then `magiclane-mcp-docs-http`) or from the Docker image — not through `npx`:
`npx` runs the server under npm, so a `SIGTERM` from `systemd` or `docker stop`
may stop npm and not the server, which then gets no chance to finish the calls
still running (see the shutdown notes under Troubleshooting).

## Endpoints

| Endpoint  | Method       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/mcp`    | POST         | One JSON-RPC 2.0 message per request (`initialize`, `tools/list`, `tools/call`, …)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `/mcp`    | OPTIONS      | CORS preflight, `204`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `/mcp`    | GET / DELETE | `405 Method Not Allowed` (`Allow: POST, OPTIONS`) — stateless, so nothing to stream or delete                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `/health` | GET, HEAD    | Liveness: `{ status, reasons?, server, version, inFlightRequests, queuedRequests, maxConcurrentRequests, inFlightBodyBytes, outbound: { active, queued, maxQueued }, upstream: { failing }, cache, fullText }`. `status` is `ok`, `degraded` (200 — slots, outbound queue or body budget full, developer.magiclane.com hanging (a fetch running over 5 s, or one that timed out within the last 60 s: page fetches failing while the indexes load), or documentation files not refreshed from developer.magiclane.com; `reasons` says which and `upstream.failing` names the files and whether a stale copy is served), `saturated` (200 here, 503 on `/ready` — the request queue is full, new tool calls are refused), `starting` (200 here, 503 on `/ready` — no index has loaded yet; the server loads them at start, and each probe asks for them again), `unavailable` (200 here, 503 on `/ready` — no index is loaded and loading one fails, so searches cannot be answered; each probe asks for a load again, which the 30 s failure memo turns into one download per 30 s) or `shutting_down` (503). A file stays in `upstream.failing` until it loads again — each probe asks for the failed files again (one download per 30 s at most), so an idle server goes back to `ok` about 16 s after the site recovers when it was refusing connections, and about 40 s after when it hung (a reload already waiting runs on to its own limit; the "hanging" memo of a timed-out fetch clears as soon as a fetch is answered, with whatever status: a 304 or a 404 too) — and a download hanging for over 5 s shows there before it times out; a request refused for the body budget keeps `degraded` for 10 s. `OPTIONS`: `204`; other methods: `405` |
| `/ready`  | GET, HEAD    | Readiness: the same body as `/health`; `503` also while `saturated`, `starting` or `unavailable`. `OPTIONS`: `204`; other methods: `405`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Any other path answers `404` with `{ "error": "Not found. MCP endpoint is /mcp" }` — or just
`{ "error": "Not found" }` when `MCP_HTTP_PATH` sets another endpoint, which is then not given away.

Required headers on `/mcp` calls — there is no session header:

```
Content-Type: application/json
Accept: application/json, text/event-stream
```

A `POST` without that `Accept` value is answered `406` by the SDK transport.

## API Examples

Initialize (nothing to capture — the next request is independent):

```bash
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

Search the documentation:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "search_docs",
    "arguments": {
      "query": "calculate route between coordinates",
      "source": "flutter",
      "limit": 5
    }
  }
}
```

```bash
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_docs","arguments":{"query":"calculate route between coordinates","source":"flutter","limit":5}}}'
```

Extract only the Dart code from an example page:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "get_code_examples",
    "arguments": {
      "url": "/docs/flutter/examples/routing-navigation/calculate-route",
      "language": "dart"
    }
  }
}
```

Check health:

```bash
curl -s http://127.0.0.1:3000/health
# {"status":"ok","server":"@magiclane/mcp-docs-server","version":"1.0.0","inFlightRequests":0,"queuedRequests":0,"maxConcurrentRequests":32,"inFlightBodyBytes":0,"outbound":{"active":0,"queued":0,"maxQueued":64},"upstream":{"failing":[]},"cache":{"entries":0,"bytes":0,"failures":0},"fullText":{"sources":0,"sections":0}}
```

## Client Integration

Responses to requests arrive as SSE (`event: message` / `data: {...}`);
notifications are acknowledged with `202` and an empty body. Parse the `data:`
line:

```typescript
async function callTool(toolName: string, args: object) {
  const response = await fetch('http://127.0.0.1:3000/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const text = await response.text();
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  const data = JSON.parse((dataLine ?? '{}').replace('data: ', ''));
  if (data.error) throw new Error(data.error.message);
  return data.result;
}
```

Alternatively use the official SDK's `StreamableHTTPClientTransport`, which
handles the handshake and SSE parsing for you; it works unchanged against a
stateless server.

## MCP Inspector

```bash
npm run inspect:build:http   # build, start the HTTP server, launch the Inspector
npm run inspect:dev:http     # same, from TypeScript sources
```

`scripts/inspect-http.mjs` points the Inspector at `MCP_HTTP_URL`
(default `http://127.0.0.1:3000/mcp`). No credentials are involved. The stdio
variants are listed in [README › MCP Inspector](https://github.com/magiclane/magiclane-mcp-docs-server/blob/HEAD/README.md#mcp-inspector).

## Docker

The image is multi-stage (`build`, `deps`, `runtime`), runs as the `node`
user, starts this HTTP entry point by default and declares a `HEALTHCHECK` on
`/health` — the liveness probe, which load and an unreachable docs site never
fail (a restart would only drop the caches); point a load balancer or a
Kubernetes `readinessProbe` at `/ready`, which is also `503` while the request
queue is full. The probe picks the port with the same rule as the server
(`test/dockerfile.test.ts` checks this). `MCP_HTTP_HOST` is `0.0.0.0` inside the container; the port is not
fixed — `MCP_HTTP_PORT` or `PORT` (Cloud Run style) chooses it, default 3000.

```bash
npm run docker:build   # docker build, with the version, revision and build-time labels filled in
docker run --rm -p 127.0.0.1:3000:3000 magiclane-mcp-docs-server
docker run --rm -p 127.0.0.1:3000:3000 --env-file .env magiclane-mcp-docs-server
```

Publish the port to `127.0.0.1` unless a reverse proxy fronts the container.
Publishing on another host port (`-p 127.0.0.1:8080:3000`) needs no extra
configuration, because loopback `Host` values are accepted on any port.

## Troubleshooting

- **`403 Forbidden: Host header "..." is not allowed`** — connect via
  `localhost`, or add the hostname to `MCP_ALLOWED_HOSTS`.
- **`403 Forbidden: origin "..." is not allowed`** — a browser `Origin` that is
  not in `MCP_CORS_ORIGIN` (compared as browsers send it: case, a trailing
  slash and a default port do not matter).
- **`405 Method Not Allowed`** — only `POST` (and `OPTIONS`) is served on the
  MCP endpoint; there is no GET stream and no session to delete.
- **`406 Not Acceptable`** — add `Accept: application/json, text/event-stream`.
- **`400 Batched (array) requests are not supported`** — send one JSON-RPC
  message per request.
- **`408`** — the request body did not arrive within 15 seconds.
- **`413`** — the request body exceeded 256 KB; the connection is closed.
- **`429 Rate limit exceeded (300 requests per 60s; a search_docs call counts 5; a find_across_sdks call counts 5)`** —
  back off for the `Retry-After` period (the seconds left in the window). Behind a proxy without `MCP_TRUSTED_PROXIES` /
  `TRUSTED_PROXY_HOPS`, every client shares the proxy's address and the limit.
- **`400 Parse error: invalid JSON`** / **`400 Bad Request`** — the body is not
  JSON, or the request line could not be routed.
- **`503 Server busy: too many requests in progress`** — all 32 slots were
  busy for 10 s, or the queue is full; retry after `Retry-After`. `/health`
  reports `degraded` while every slot is busy and `saturated` while the queue
  is full (`/ready` then answers `503`).
- **`503 Too many requests in progress from this client (4 at once)`** — this
  client already runs its share; retry when one of its calls has finished.
- **`503 ... request bodies in flight`** — this client (1 MB) or the server
  (16 MB) has too many request bodies still arriving. Both budgets are charged
  as the bytes arrive, so the limits hold however many slow bodies were
  admitted at once.
- **`The documentation host is busy`** / **`Too many uncached documentation
pages requested by this client`** (tool errors) — the outbound queue (64, or
  this client's 16) is full, or this client fetched 120 new pages within a
  minute; retry after the stated wait. Only fetches that are sent count
  against the 120, whether or not the call stays for the answer: one refused
  as busy, abandoned while queued, or given its slot with under 1 s of its
  call's time left (and so not sent) is free. Freed outbound slots go
  round-robin across clients, so one client's queued batch does not hold up
  another client's page. Clients whose pages hang can still hold every slot
  between them for their first round: three (four, one and one — or with the
  fifth the first borrowed while it was alone, 7 fetches), until those
  fetches time out, at most 20 s; two cannot, whatever order their pages come
  in, as the last free slot is kept for a client running nothing yet while
  fewer than three clients run pages, and the slot the first borrowed is lent
  to one the moment it asks. For the next 60 s the last free slot is kept for
  a client running nothing yet however many clients run pages, whether or not
  a page is answered meanwhile, so a newcomer gets it at once, and its next
  page too; a batch's pages queued meanwhile keep waiting for up to its 50 s
  (or until its request budget ends, when that is later).
- **`N page(s) did not load in time`** (a `read_docs_batch` answer) — the
  site was slow to answer, or this server busy. A batch's pages take their
  turns for an outbound slot round-robin with the other clients' pages, and
  over HTTP they wait for them until the call's request budget ends (55 s
  after the request arrived), so under heavy load the pages whose turn did not
  come by then are listed, the others returned: read the listed ones with
  another `read_docs_batch` call.
- **`503 Server is shutting down`** / `/health` reports `shutting_down` — the
  process received `SIGINT`/`SIGTERM` and is draining: it accepts no new
  connection, closes idle ones, lets the calls already running finish for
  up to 8 s (below the 10 s `docker stop` waits; give Kubernetes no shorter a
  grace period), and exits 0 — or 1, logging it, when calls were still
  running at 8 s and were cut. Connections open with no call running (one
  that connected and sent nothing, a half-sent request, a body still
  arriving) do not hold it: as soon as no call is running at all they are
  closed and it exits 0, within a second of the last call ending — this
  server opens no notification stream (`GET /mcp` is `405`).
- **`Cannot start HTTP server on 127.0.0.1:3000: listen EADDRINUSE`** — the
  port is taken; the process exits with status 1.

## Production Deployment

Bind to localhost and put a reverse proxy in front for TLS and access control.

nginx:

```nginx
server {
    listen 443 ssl;
    server_name docs-mcp.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;   # required for SSE streaming
    }
}
```

Caddy:

```
docs-mcp.yourdomain.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1   # required for SSE streaming
    }
}
```

With either proxy on the same machine, start the server with:

```bash
MCP_ALLOWED_HOSTS=docs-mcp.yourdomain.com \
MCP_TRUSTED_PROXIES=127.0.0.1 \
TRUSTED_PROXY_HOPS=1 \
node dist/docs-server-http.esm.js
```

so the `Host` check accepts the public name and rate limiting keys off the real
client address from `X-Forwarded-For` rather than the proxy's. If the proxy
runs on another host or in another container, put its address (or its subnet,
e.g. `172.18.0.0/16`) in `MCP_TRUSTED_PROXIES` instead of `127.0.0.1`.

**In Docker, `127.0.0.1` is the wrong address for a proxy on the host.** With
`docker run -p 127.0.0.1:3000:3000` and the proxy on the same machine, the
proxy's connections reach the container from the Docker bridge gateway
(`172.17.0.1` on the default bridge; `docker network inspect bridge` shows
it), not from `127.0.0.1`. With `MCP_TRUSTED_PROXIES=127.0.0.1` the server
would ignore `X-Forwarded-For` and put every client behind the proxy into one
rate-limit window: the whole team would share 300 requests a minute, 4
concurrent calls and 1 MB of request bodies. Set the gateway instead:

```bash
docker run --rm -p 127.0.0.1:3000:3000 \
  -e MCP_ALLOWED_HOSTS=docs-mcp.yourdomain.com \
  -e MCP_TRUSTED_PROXIES=172.17.0.1 \
  -e TRUSTED_PROXY_HOPS=1 \
  magiclane-mcp-docs-server
```

Check it by calling `/health` through the proxy from two machines: each
should have its own 300-request window.

**Trust means trust.** Whatever is in `MCP_TRUSTED_PROXIES` may set
`X-Forwarded-For`. With the bridge gateway (or a subnet) trusted, so may any
process on the Docker host, or any container on that network, that connects
to the published port directly — and it can then pick its own rate-limit key.
So the container must be reachable only through the proxy: run the proxy on
the same Docker network and do not publish the server's port at all (the
proxy reaches it by container name, and `MCP_TRUSTED_PROXIES` names the
proxy's address on that network), or publish it on `127.0.0.1` only on a host
nobody else runs code on.

The server has no authentication of its own, so keep it bound to `127.0.0.1`
and terminate access control at the proxy (TLS, allow-lists, or your gateway's
auth) whenever it is reachable beyond localhost. The built-in `Host`/`Origin`
validation blocks DNS-rebinding and cross-origin browser reads, and the rate
and body limits bound abuse, but none of that is a substitute for an auth layer
on a public deployment.
