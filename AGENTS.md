# AGENTS.md — Magic Lane MCP Docs Server

## Project Overview

The **Magic Lane MCP Docs Server** is a TypeScript-based Model Context Protocol
(MCP) server that gives AI agents searchable, always-current access to the
[Magic Lane developer documentation](https://developer.magiclane.com/docs):
the developer guides, the Maps SDKs for Flutter, Android, iOS, C++, and
TypeScript, and the Cloud REST APIs. Nothing is bundled — content is fetched at
runtime from Magic Lane's published `llms.txt` / `llms-full.txt` files. The
documentation is public: there is no API key and no authentication.

Package: `@magiclane/mcp-docs-server` (also the MCP server name reported in
`serverInfo`). Commands: `mcp-docs-server` and `magiclane-mcp-docs` (stdio; the
first is named after the package, so `npx -y @magiclane/mcp-docs-server` runs
it) and `magiclane-mcp-docs-http` (Streamable HTTP). The docs configure
`magiclane-mcp-docs`.

## Core Capabilities

- Documentation search with whole-word index ranking and full-text excerpts (`search_docs`)
- Single and batch page retrieval as markdown, paged (`read_doc`, `read_docs_batch`)
- Documentation browsing grouped by source and URL-derived section (`list_docs`)
- Code-example extraction with language filtering and paging (`get_code_examples`)
- Cross-SDK topic lookup, one block per source (`find_across_sdks`)
- Recency tracking via embedded "Last updated" dates, all sources (`list_recent_updates`)
- Product guides for the Magic Lane MCP Server and Map Studio (`get_product_guide`)
- `llms.txt` indexes exposed as MCP resources
- Honest failure reporting: sources that could not be fetched are listed in a
  trailing "## Sources not loaded" block (`find_across_sdks` marks them inline,
  "(index not loaded: …)"), and a call is an error when no requested source
  loaded — never "no documentation"

## Tech Stack & Dependencies

- **Runtime**: Node.js 22+ (`engines: >=22`; ESLint 10 needs 22.13+) with TypeScript 5.9+, pure ESM
- **Protocol**: Model Context Protocol via `@modelcontextprotocol/sdk` (stdio + stateless Streamable HTTP)
- **Validation**: Zod schemas at every tool boundary
- **Build**: Rollup (two ESM bundles with shebang banners, no declaration emit)
- **Testing**: Vitest 4 with v8 coverage (thresholds at 100% statements/branches/functions/lines)
- **Quality**: ESLint 10 flat config, Prettier (120 columns), cspell, husky + lint-staged

## Project Architecture

The code is layered: each layer depends only on the ones beneath it. Two thin
process entry points wire up a shared server factory; the factory registers the
tools; the tools call a small docs layer; and every outbound request funnels
through a single HTTP client governed by one fetch policy.

```
.
├── src/
│   ├── docs-server.ts             # stdio entry point (thin: createServer() + StdioServerTransport)
│   ├── docs-server-http.ts        # Streamable HTTP entry point (thin: env, listen, node:http timeouts,
│   │                              #   signals, exit codes) — all request handling is in http/app.ts
│   ├── server.ts                  # createServer() / createTools(): installs the tool classes + resources
│   ├── version.ts                 # SERVER_NAME / SERVER_VERSION read from package.json
│   ├── config/
│   │   ├── constants.ts           # grouped frozen dicts: DOCS, FETCH, CACHE, LIMITS, HTTP + isAllowedDocUrl
│   │   └── env.ts                 # env parsers, ENV_DEFAULTS, readEnv(), ENV, VERBOSE
│   ├── http/
│   │   └── app.ts                 # createHttpApp(): routing, Host/Origin checks, cost-weighted rate limit,
│   │                              #   per-client body and slot shares, request queue, stateless transport
│   │                              #   per POST, cancellation on disconnect, /health + /ready
│   ├── utils/
│   │   ├── http-client.ts         # the one fetch pipeline: LRU cache, revalidation, retry, redirects, caps,
│   │   │                          #   bounded priority queue, outage memo, per-client fetch budget
│   │   ├── request-context.ts     # per-request abort signal + client key (AsyncLocalStorage)
│   │   ├── http-security.ts       # Host allowlist, CORS policy, trusted proxies, client IP, rate-limit key
│   │   ├── page-links.ts          # webPageLinks / webPageUrls: page links as the web pages people open, not .md
│   │   ├── calls-in-flight.ts     # the MCP calls running now (trackCall, callsSettled, callsSettledOrStalled)
│   │   ├── jsonrpc-lines.ts       # JsonRpcLineGuard: stdin lines checked before the transport; invalidRequestError
│   │   ├── quote.ts               # quoteArgument: an argument echoed back on one line, cut between characters
│   │   ├── clock.ts               # withinLast / stillAhead: wall-clock windows safe against a clock step back
│   │   ├── errors.ts              # errorMessage(err): the message of an unknown throw; errorLine(err): an error
│   │   │                          #   as one log line (a zod error as its closest shape's issues); messageLabel();
│   │   │                          #   protocolErrorLine(): a protocol error's stderr line, folded and capped
│   │   └── logger.ts              # VERBOSE stderr logging
│   ├── docs/
│   │   ├── docs-index.ts          # parse llms.txt, URL-derived sections, word-based ranking (searchIndex)
│   │   ├── document.ts            # normalizeDocRef + getDocument + sliceDocument (paging)
│   │   ├── full-text.ts           # split llms-full.txt into pages, attach URLs, excerpt search
│   │   ├── source-memo.ts         # per-source memo (indexes, full text): revalidation, stale-on-failure
│   │   ├── markdown.ts            # CommonMark line scanner (fences, indented code, list indents, headings) + heading-anchor stripping
│   │   ├── code-examples.ts       # extract code blocks (fenced or indented) with their nearest heading, aliases
│   │   └── updates.ts             # parse "Last updated" markers (UTC), collect recent
│   ├── resources/
│   │   └── llms-index-resource.ts # expose raw llms.txt indexes as MCP resources
│   └── tools/                     # base-tool.ts + source-report.ts + output-schemas.ts + one BaseTool subclass per tool (8)
├── test/                          # mirrors src/ (config, docs, http, resources, tools, utils) + setup.ts,
│                                  #   helpers.ts, built-bundle.test.ts (offline, needs dist/), integration.test.ts (live, opt-in)
├── docs/                          # per-client setup guides (VS Code, Visual Studio, Android Studio, Cursor, Claude Desktop) + HTTP server
├── scripts/                       # clean / prepare (husky) / release (+ changelog, its CHANGELOG check, and release-files,
│                                  #   its checkout checks) / inspect-http / live-tests / sync-manifest / docker-build
├── .husky/pre-commit              # runs lint-staged
├── .vscode/                       # launch.json (F5 run/debug) + tasks.json (build, local gates)
├── tsconfig.json                  # editor/default project — src + test, noEmit, Node types
├── tsconfig.build.json            # build project — src only, noUncheckedIndexedAccess (rollup disables declarations)
├── rollup.config.js               # two ESM bundles with shebang banners
├── vitest.config.ts               # test config, setup file, 100% coverage thresholds, entry points excluded
├── manifest.json                  # MCP Bundle (.mcpb) manifest — tools synced by scripts/sync-manifest.mjs
├── Dockerfile                     # multi-stage (build / deps / runtime), user node, HTTP entry, HEALTHCHECK
├── .env.example                   # every environment variable with its default
├── .mcpbignore / .npmignore       # keep tests and tooling out of the bundle / tarball (the tarball ships src/)
├── LICENSE, LICENSES/, REUSE.toml # Apache-2.0, every file labelled (reuse lint)
├── CODE_OF_CONDUCT.md, SECURITY.md
└── CHANGELOG.md                   # Keep a Changelog: entries wait under [Unreleased], dated on the release day
```

### Layers and request flow

1. **Entry points** (`docs-server.ts`, `docs-server-http.ts`) build a server with
   `createServer()` and attach a transport. The HTTP entry reads `ENV`, builds
   the app with `createHttpApp()`, sets the `node:http` timeouts (headers 15 s,
   request 60 s, both checked every second; idle socket 120 s, keep-alive 5 s),
   exits 1 on a failed listen or an uncaught exception, and on
   `SIGINT`/`SIGTERM` drains: calls already running get up to 8 s
   (`HTTP.shutdownGraceMs`), idle connections are closed as they go idle,
   then it exits 0, or 1 when it had to cut calls still running (connections
   with no call running — one that sent nothing, a half-sent request, a body
   still arriving — are closed as soon as no call is running at all, so they
   never hold the exit; `app.stats().servingRequests` counts the calls, light
   ones included). The stdio entry, when the client closes stdin, finishes the
   calls still running (`callsSettledOrStalled()` in
   `utils/calls-in-flight.ts`): each request the site was sent is waited for
   on its own limits, its first byte up to 20 s, so a one-shot pipe gets
   every answer; the first request the site leaves unanswered for 20 s stops
   the sending (`stopSendingOnHang()`: a killed client's calls on a hanging
   page must not keep the process alive and fetching), and the calls answer
   with what they have; 3 s with nothing to wait for from the site — no
   request within its own limits, no byte (`STDIO.closeGraceMs`) — gives up
   the calls still running. It then closes and exits once stdout has taken
   the results: 0 when every call was answered, 1 when some were given up; a
   transport that closes on its own exits 1; a broken stdout pipe exits 1.
2. **HTTP app** (`http/app.ts`) is a pure function of its options. Per request:
   common headers (`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
   CORS), `OPTIONS` → 204, Host allowlist (403), Origin policy (403), rate
   limit on every route but `OPTIONS` (300/60 s per client, IPv6 per /64, 429;
   `/health` and `/ready` in a second window of their own per client), then
   `/health`, `/ready` or the MCP path. The MCP path accepts `POST` only (405 otherwise),
   buffers the body under a 256 KB cap (413), a 15 s deadline (408), a 16 MB
   process-wide budget and a 1 MB per-client share — both charged as bytes
   arrive (503), rejects JSON-RPC
   arrays (400), charges `search_docs` / `find_across_sdks` 5 requests against
   the rate limit (a weighted call over the limit keeps only the 1 counted on
   arrival; one refused with 503 has been counted in full), runs at most 32 requests
   at once and 4 per client — others wait up to 10 s in a queue of 64 (503
   beyond) — while `initialize`, `ping`,
   the list methods and notifications skip the slots, and creates a **fresh
   server/transport pair per request** (`sessionIdGenerator: undefined` —
   stateless, no session ids, no GET stream). A client that disconnects has
   its tool work cancelled; its slot is freed when that work has stopped.
3. **Server factory** (`server.ts`) instantiates the eight tool classes via
   `createTools()` and calls `installTo(server)` on each, then registers the
   `llms.txt` resources. `BaseTool.installTo` is where read-only annotations,
   VERBOSE invocation logging, and error wrapping are applied uniformly.
4. **Tools** (`tools/*`) are `BaseTool` subclasses: the SDK validates arguments
   against each tool's Zod schema, then `run()` delegates to the docs layer —
   tools never fetch directly. Multi-page tools report per-item failures
   inline and set `isError` only when everything failed; search/list tools use
   `tools/source-report.ts` for failed-source wording.
5. **Docs layer** (`docs/*`) turns indexes and pages into structured results:
   parsing and ranking, page splitting and excerpt search, reference
   normalization and slicing, code extraction, recency. Indexes and full text
   are memoized per source in `source-memo.ts` (1 h TTL, ETag/Last-Modified
   revalidation, served stale when a refresh fails or takes over 5 s, a failed
   refresh remembered for 30 s). An index that parses to no pages is a failed
   source. Page text is stemmed once at load (`wordStats`), so queries are
   lookups. A split of `llms-full.txt` with more pages than the index (a page's
   own `---` + `###`) or fewer (an unclosed fence) is repaired against the
   index titles (`reconcilePages`, pure, per index version); a section the
   index does not list that opens like a page (`startsPage`: "Last updated:",
   or a list of page cards — unless the cards all link to pages beside the
   page before it, or none to the page listed next, a "See also" that is its
   own heading), or that is titled as another number of a listed series
   ("Migrate to 3.1.4" beside "Migrate to 3.1.3"), is a page the index
   dropped, kept apart with no URL rather than merged into another page; a
   split that merely disagrees — the two files at different versions — is
   left alone.
6. **HTTP client** (`utils/http-client.ts`) is the only code that touches the
   network. Every request is gated by the fetch policy in `config/constants.ts`
   (`isAllowedDocUrl` — HTTPS on `developer.magiclane.com`, default port, no
   credentials), limited to 6 concurrent fetches (7 while a client holds a slot it borrowed when alone, the extra one for a client running nothing yet; a client starts at most 4 page fetches while another
   waits, all but one when alone; the last free slot is kept for a client running nothing yet while fewer than three
   clients run pages, while a fetch hangs, for 60 s after a fetch timed out, and while a borrowed slot is held; the
   probes' reloads run 2 at a time after the calls' fetches, one
   with no answer for 5 s handing its turn on and running beside the slots, 2 at most) with a bounded queue (64
   page fetches, 16 per client; the index and full-text files go first and
   are never charged), given at most 20 s to get a slot, 20 s for the answer
   and 30 s in all from being queued (50 s for the pages of a read_docs_batch call of more than 4, or over HTTP until the
   call's request budget ends when that is later; a probe's background
   reload waits 30 s for a slot and takes 50 s in all) — the single retry on a quick 5xx or
   network error included, never after a timeout; an HTTP call stops waiting for its pages 55 s after its request
   arrived (`FETCH.requestBudgetMs`) — served from an
   LRU page cache (200 entries / 5 MB in bytes, 512 KB per entry, 1 h),
   de-duplicated in flight (aborted when every waiting request was cancelled,
   and never handed to a later caller once aborted), size-capped at 10 MB,
   refused when the answer is HTML, negative-cached for 60 s on 4xx and 30 s
   on an outage, reserved against a per-HTTP-client budget of 120 uncached
   pages per minute when queued (given back when the fetch never starts), given outbound slots round-robin
   across clients, and followed through at most 3 redirects that are re-validated on
   every hop.

## Development Guidelines

### Development Philosophy

- **Type Safety First**: Leverage TypeScript's static analysis to catch errors at compile time
- **Pure where possible**: the HTTP app, the security helpers, ranking and slicing are pure functions of their inputs (injectable clocks, env sources), which is what makes 100% coverage honest
- **Defensive Programming**: Validate all inputs and bound every resource (query length, token count, body size, concurrency)
- **Test-Driven Development**: Write tests to guide implementation and ensure reliability

### Code Implementation Guidelines

#### Planning Phase

- Begin with detailed pseudocode and architecture planning
- Document API contracts and data flow before coding
- Consider error scenarios and edge cases upfront
- Design schemas and validation rules early

#### Code Style Standards

- Use 2-space indentation for consistency
- Prefer single quotes for strings (except when avoiding escaping)
- Use trailing commas in multiline objects and arrays (`es5`)
- Eliminate unused variables and imports
- Prettier owns formatting: `printWidth` is 120 (`.prettierrc`, the one Prettier configuration)
- LF line endings everywhere: `.gitattributes` (`* text=auto eol=lf`) makes every checkout LF, Windows included, as prettier's `endOfLine: "lf"` and `npm run check` expect
- SPDX header (`Apache-2.0`, Magic Lane International B.V.) at the top of every source, test and script file; `REUSE.toml` covers configuration files that cannot carry one (JSON, `.husky/pre-commit`, ignore files)

#### Naming Conventions

- **PascalCase**: Types, interfaces, classes, enums (`McpServer`, `GuidePage`, `SearchDocsTool`)
- **camelCase**: Variables, functions, methods, properties (`createServer`, `createHttpApp`, `normalizeDocRef`)
- **UPPER_SNAKE_CASE**: Constant dictionaries and environment variables (`DOCS`, `LIMITS`, `MCP_HTTP_PORT`)
- **kebab-case**: File names and directory names (`product-guide-tool.ts`, `http-client.ts`)

## Environment Setup

### Development Requirements

- **Node.js**: 22 or newer (the development toolchain needs 22.13+)
- **npm**: comes with Node.js
- No API key or account required — the documentation is public.
- `VERBOSE` (default `false`) enables tool-invocation logging on stderr.

### Installation Steps

```bash
# 1. Clone the repository
git clone https://github.com/magiclane/magiclane-mcp-docs-server.git
cd magiclane-mcp-docs-server

# 2. Install dependencies
npm install

# 3. (Optional) environment variables — none are required
cp .env.example .env
# `npm start` does not read .env; load it with node --env-file=.env <bundle>

# 4. Build the project
npm run build

# 5. Run the offline tests to verify the setup
npm test

# 6. Start the development server
npm run dev
```

## Build and Test Commands

### Development Commands

```bash
npm install            # Install dependencies
npm run build          # Rollup build (TypeScript -> dist/*.esm.js), runs `clean` first
npm start              # Run the compiled stdio server (requires build)
npm run start:http     # Run the compiled Streamable HTTP server
npm run dev            # stdio server from sources (node --import tsx src/docs-server.ts)
npm run dev:http       # HTTP server from sources
npm run watch          # stdio server from sources, auto-restart on changes
npm run clean          # Remove dist/ and coverage/
npm run type-check     # tsc --noEmit on tsconfig.json and tsconfig.build.json
```

### Testing Commands

```bash
npm test               # Offline, hermetic unit tests (vitest run)
npm run test:watch     # Watch mode
npm run test:ui        # Vitest UI
npm run test:coverage  # Coverage with 100% thresholds on all metrics
npm run test:live      # Live end-to-end suite — needs `npm run build` and the network; FAILS without a build
```

### Quality and Release Commands

```bash
npm run lint           # eslint src test scripts *.js *.ts
npm run lint:fix
npm run format         # prettier --write .
npm run format:check   # prettier --check .
npm run spellcheck     # cspell "**/*.md" "**/*.ts"
npm run check:manifest # exit 1 when manifest.json tools/version differ from the tool classes
npm run sync:manifest  # rewrite manifest.json from createTools()
npm run check          # build, then the static and test gates: types, lint, format, spelling, manifest, tests + 100% coverage
                       # (npm audit, reuse lint and test:live are run separately; release.js checks the checkout and the
                       # CHANGELOG entry's date, then runs check + reuse lint + audit; test/licensing.test.ts checks the
                       # license texts offline in every npm test)
npm run release        # (clean git clone, REUSE 6.2.0, CHANGELOG entry dated today) npm ci → check (builds first) → reuse lint → npm audit --omit=dev → npm ci --omit=dev → mcpb pack → npm pack → npm ci
                       # Checked before anything runs, each refusal saying what to do: the top folder of a git checkout;
                       # no edited or untracked file, none marked skip-worktree or assume-unchanged, and no git-ignored
                       # file an archive would take (scripts/release-files.mjs); the version's CHANGELOG entry dated
                       # today and nothing left under Unreleased (scripts/changelog.mjs); REUSE 6.2.0 found
npm run docker:build   # docker build with the version, revision and build-time labels filled in
```

### Build Verification

```bash
# Verify build output exists
ls dist                # docs-server.esm.js, docs-server-http.esm.js (+ .map)

# Smoke-test the compiled servers
node dist/docs-server.esm.js          # stdio: prints "running on stdio" to stderr, waits for JSON-RPC
node dist/docs-server-http.esm.js     # HTTP: listens on http://127.0.0.1:3000/mcp; GET /health

# MCP Inspector
npm run inspect:dev                   # against the stdio server from sources
npm run inspect:build:http            # build, start the HTTP server, launch the Inspector
```

## Development Patterns & Testing

### Architecture Overview

- **Entry points** (`src/docs-server.ts`, `src/docs-server-http.ts`): thin;
  excluded from unit coverage (`vitest.config.ts`) because they only read the
  environment, listen and handle signals. The live suite runs the stdio bundle
  as a subprocess.
- **HTTP app** (`src/http/app.ts`): `createHttpApp(options)` returns
  `{ handler, sweep, stats, close }`; tested over a real `node:http` server on
  an ephemeral port in `test/http/app.test.ts`, with an injectable clock for
  rate windows and a fake `createServer` where needed.
- **Server factory** (`src/server.ts`): `createTools()` is the single list of
  tool instances; `createServer()` installs them, the resources, and the
  server-level `instructions`.
- **Tool layer** (`src/tools/*`): an abstract `BaseTool` (`base-tool.ts`) and one
  concrete class per tool that extends it (`GetDocumentTool`, `SearchDocsTool`,
  …). Each declares `name` / `description` / `annotations` / Zod `inputSchema`
  (and optionally `outputSchema`) and implements `run()`. `source-report.ts`
  holds the shared wording for failed sources.
- **Docs layer** (`src/docs/*`): index parsing/ranking, page splitting and
  excerpt search, reference normalization and slicing, code extraction,
  recency, the per-source memo, and the markdown helpers. Tools call this; they
  never fetch directly.
- **Config layer** (`src/config/*`): `constants.ts` holds every fixed value in
  grouped frozen dictionaries — `DOCS` (baseUrl/host/sources), `FETCH`, `CACHE`,
  `LIMITS`, `HTTP` — plus `isAllowedDocUrl`, the fetch policy that guards the
  allowlist it sits beside. `env.ts` holds everything read from the environment:
  the parsers, `ENV_DEFAULTS`, and `readEnv()` merging over them into `ENV`.
- **Utility layer** (`src/utils/*`): `http-client.ts` (the single
  `fetch`-based pipeline), `http-security.ts` (Host/Origin/proxy/IP helpers),
  `request-context.ts` (the request's abort signal and client key),
  `page-links.ts` (`webPageLinks`, `webPageUrls`: page links as the web pages
  people open, in text and in structured content), `calls-in-flight.ts` (the
  calls running now, which the stdio entry finishes before it exits),
  `jsonrpc-lines.ts` (`JsonRpcLineGuard`: the stdio lines checked before the
  transport reads them, bad requests answered), `quote.ts` (`quoteArgument`:
  an argument echoed back on one line), `clock.ts` (`withinLast`, `stillAhead`:
  wall-clock windows safe against a clock step back), `errors.ts`
  (`errorMessage`, `errorLine`, `messageLabel`, `protocolErrorLine`), `logger.ts` (VERBOSE-gated
  stderr logging); `src/version.ts` provides the identity from package.json.
- **Schema layer**: a Zod `z.object` per tool; `BaseTool.installTo` hands it,
  made `.strict()`, to the SDK, which validates arguments before `run()`
  executes — an unknown or misspelled argument is an input error.

### Core Patterns

#### 1. BaseTool (the shared abstract class)

Every tool extends `BaseTool` (`src/tools/base-tool.ts`), adapted from the shared
pattern in `magiclane-mcp-server` for a documentation (text) server. `installTo`
is the one place registration, VERBOSE logging, and error wrapping happen, so no
tool repeats them:

```typescript
export abstract class BaseTool<InputSchema extends ZodTypeAny, OutputSchema extends ZodTypeAny = ZodTypeAny> {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly annotations: ToolAnnotations;
  readonly inputSchema: InputSchema;
  readonly outputSchema?: OutputSchema;

  constructor(params: { inputSchema: InputSchema; outputSchema?: OutputSchema }) {
    this.inputSchema = params.inputSchema;
    this.outputSchema = params.outputSchema;
  }

  installTo(server: McpServer): RegisteredTool {
    const config = {
      title: this.annotations.title,
      description: this.description,
      inputSchema: (this.inputSchema as unknown as AnyZodObject).strict(),
      annotations: this.annotations,
    }; /* + outputSchema.shape when present */

    return server.registerTool(this.name, config, (rawInput, extra) => {
      logToolInvocation(this.name); // VERBOSE stderr logging, once, for every tool
      // Run inside the request context: the SDK's abort signal reaches every
      // fetch, and the HTTP app tracks the work until it has really stopped.
      const work = withRequestContext({ signal: extra.signal }, async () => {
        try {
          return await this.run(rawInput, extra);
        } catch (err) {
          // Never throw across the protocol — return the reason as an isError result.
          return this.errorResponse(`${this.name} failed: ${errorMessage(err)}`);
        }
      });
      currentRequest()?.track?.(work);
      return work;
    });
  }

  abstract run(rawInput: unknown, extra?: unknown): Promise<CallToolResult>;

  protected textResponse(text: string, structuredContent?: Record<string, unknown>): CallToolResult {
    /* ... */
  }
  protected errorResponse(message: string): CallToolResult {
    /* { isError: true, ... } */
  }
}
```

`createServer()` just instantiates each class and installs it — `createTools()`
is the single enumeration point, and `scripts/sync-manifest.mjs` derives
`manifest.json`'s `tools` from it:

```typescript
for (const tool of createTools()) {
  tool.installTo(server);
}
registerLlmsIndexResources(server);
```

#### 2. A concrete tool

Each tool is a class: declare the identity and the schema, implement `run()`,
and return via the `BaseTool` helpers. `run()` handles _expected_ failures with
`this.errorResponse(...)`; anything unexpected is caught by `installTo`:

```typescript
const InputSchema = z.object({/* see pattern 3 */});
type Input = z.infer<typeof InputSchema>;

export class GetDocumentTool extends BaseTool<typeof InputSchema> {
  readonly name = 'read_doc';
  readonly description = 'Fetch the markdown content of a specific Magic Lane documentation page ...';
  readonly annotations: ToolAnnotations = { ...READ_ONLY_ANNOTATIONS, title: 'Get a Magic Lane documentation page' };

  constructor() {
    super({ inputSchema: InputSchema });
  }

  async run(rawInput: unknown): Promise<CallToolResult> {
    const { url, offset, maxChars } = rawInput as Input;
    try {
      const doc = await getDocument(url);
      const slice = sliceDocument(doc.content, offset, maxChars);
      const header = `# Document: ${doc.url}\n\n${rangeNote(slice.start, slice.end, slice.total, slice.hasMore)}\n\n`;
      return this.textResponse(header + slice.text);
    } catch (err) {
      return this.errorResponse(`Failed to fetch document "${url}": ${errorMessage(err)}`);
    }
  }
}
```

A tool with structured output (`search_docs`, `list_docs`, `find_across_sdks`,
`list_recent_updates`) also passes an `outputSchema` to `super(...)` and calls
`this.textResponse(text, structuredContent)`. Structured content must hold the
whole result, never just `failedSources`: some clients show the model only the
structured content, so a listing whose structured part lacked its data read as
empty. Shared pieces live in `src/tools/output-schemas.ts`; `test/server.test.ts`
fails a tool that returns structured content without a schema, or without data.

#### 3. Zod input schemas

Each tool declares a `z.object` schema, inferred to the `run()` argument type
(`z.infer`), with a `.describe()` on every field the agent reads and every
bound taken from `LIMITS` in `config/constants.ts`:

```typescript
const InputSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(LIMITS.maxRefChars)
    .describe('Absolute developer.magiclane.com URL or a /docs/... path of the page to fetch.'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Character offset to start from (for paging through long pages).'),
  maxChars: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.maxDocumentChars)
    .default(LIMITS.defaultDocumentChars)
    .describe('Maximum characters to return from the offset. The response says how to fetch the next chunk.'),
});
```

#### 4. One outbound HTTP pipeline

Tools and the docs layer never call `fetch` directly — everything goes through
`src/utils/http-client.ts`, gated by the fetch policy in `config/constants.ts`.
That client adds the timeout, the concurrency cap, the LRU cache with
ETag/Last-Modified revalidation, the single retry, in-flight de-duplication,
size caps, HTML refusal, negative caching and per-hop redirect re-validation,
so no tool has to:

```typescript
/** The single gate: HTTPS on the documentation host only, applied to every fetch and every redirect hop. */
export function isAllowedDocUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname.toLowerCase() === DOCS.host &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === ''
  );
}
```

#### 5. Failed sources are never "no results"

`loadIndex()` / `loadFullTextSections()` return `{ entries | sections, failed }`
with `Promise.allSettled` semantics. Tools append `sourceFailureNote(failed)`
(the "## Sources not loaded" block; `find_across_sdks` marks a failed source
inline in its block instead) to every response and return
`allSourcesFailedMessage(...)` as an error when every requested source failed.
Keep this invariant when adding a tool that reads indexes or full text.

### Testing Framework

Vitest 4 with v8 coverage held at **100%**. `test/setup.ts` runs before every
test file: it deletes every server environment variable (so a developer's
exported `VERBOSE` or `MCP_HTTP_PATH` cannot change behaviour or coverage) and
replaces `globalThis.fetch` with a guard that throws on any real network
request. Tools are tested end-to-end through a real MCP client over
`InMemoryTransport` — not by calling internals — with the memos and the page
cache pre-seeded:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectClient, seedFixtures, textOf } from '../helpers.js';
import type { TestClient } from '../helpers.js';

describe('read_doc', () => {
  let t: TestClient;

  beforeEach(async () => {
    seedFixtures(); // preloads every doc source into the memos and the page cache
    t = await connectClient(); // real server + real client over InMemoryTransport
  });

  afterEach(async () => {
    await t.close();
    vi.unstubAllGlobals();
  });

  it('fetches a page by docs path and prefixes the resolved URL', async () => {
    const result = await t.client.callTool({
      name: 'read_doc',
      arguments: { url: '/docs/guides/get-started' },
    });
    expect(textOf(result)).toContain('# Document: https://developer.magiclane.com/docs/guides/get-started');
    expect((result as { isError?: boolean }).isError).not.toBe(true);
  });
});
```

Testing rules:

- `connectClient()` wires the real server to a real client; `seedFixtures()`
  preloads all sources (indexes via `seedIndex`, full text via
  `seedFullTextSections`, pages via `seedHttpCache`). Fixtures have the same
  shape as the published files: no section headings in the index, pages
  separated by `---` in the full text.
- Simulate upstream behaviour with `stubFetch(...)` from `test/helpers.ts` —
  it replaces `globalThis.fetch` itself, so undo it with the `restore()` it
  returns (`vi.unstubAllGlobals()` does not) — or with
  `vi.stubGlobal('fetch', ...)` and `vi.unstubAllGlobals()` in `afterEach`. Clearing a cache does **not** simulate an outage — the guard in
  `test/setup.ts` turns the resulting fetch into a thrown error, which reads as
  a failed source, not as a network call.
- The HTTP layer is tested in `test/http/app.test.ts` against a real
  `node:http` server on an ephemeral port; use the injectable `now` and small
  `limits` instead of real time or large bodies.
- The SDK reports invalid arguments as `{ isError: true }` results, **not**
  rejected promises — assert on the result.
- Test timeouts live in `vitest.config.ts`, apart from the 15 s limit of the polling `waitFor` helper in `test/http/app.test.ts`; a test that needs time to pass uses fake timers (`vi.useFakeTimers` + `advanceTimersByTimeAsync`) or `vi.waitFor`, never a wall-clock sleep.
- Structural tests assert the EXACT tool list (`test/server.test.ts`,
  `test/manifest.test.ts`) — update them and run `npm run sync:manifest` when
  adding or renaming a tool; `test/built-bundle.test.ts` then compares the
  built bundle's tools and resources with the sources (`npm run check` builds
  first; a bare `npm test` without `dist/` skips it).
- `npm run test:live` (`scripts/live-tests.mjs`) sets `LIVE_DOCS_TESTS=1` and
  runs `test/integration.test.ts` (the live files: index sizes, the page
  split, a live 404, the longest page)
  against the live site with the built stdio bundle; it fails when `dist/` is
  missing.

When adding a tool or feature, study the nearest existing tool and mirror it: a
`BaseTool` subclass with an inline Zod schema (`.describe()` on every field,
bounds from `LIMITS`), `this.errorResponse` for expected failures, the
failed-source invariant for anything that reads indexes, and an
`InMemoryTransport` test. Consistency across the tool modules is what keeps the
surface predictable and the coverage honest.

### Key Implementation Principles

1. **Type Safety**: Full TypeScript support with runtime validation using Zod
2. **Tool Pattern**: Abstract `BaseTool` class with consistent structure and error handling
3. **Error Handling**: Consistent error propagation across all layers; a network failure is reported as such, never as a documentation gap
4. **Modularity**: Clear separation between entry points, HTTP app, tools, docs layer and utilities
5. **Testing**: Offline, hermetic tests at 100% coverage; the live site only in the opt-in suite
6. **Security**: Input bounds everywhere, one fetch gate for the documentation host, and a stateless HTTP transport with body, concurrency and rate limits — but no authentication, so bind to localhost or front it with a proxy

Consistency is key to maintainability. When adding new features or tools, study how similar functionality is implemented and maintain the same patterns and conventions throughout the codebase.
