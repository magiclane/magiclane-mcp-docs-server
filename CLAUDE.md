# CLAUDE.md — Magic Lane MCP Docs Server

Guidance for Claude (and Claude Code) when working in this repository.

## Quick Commands

```bash
# Development
npm install                  # Install dependencies
npm run build                # Rollup build TypeScript -> dist/*.esm.js (two bundles, no .d.ts)
npm run dev                  # Run stdio server from sources (node --import tsx)
npm run dev:http             # Run Streamable HTTP server from sources
npm run lint                 # ESLint (flat config) over src, test, scripts and the top-level configs
npm run format               # Prettier (120 columns)
npm run inspect:dev          # MCP Inspector against the stdio server
npm start                    # Run compiled stdio server (dist/docs-server.esm.js)
npm run start:http           # Run compiled HTTP server (dist/docs-server-http.esm.js)

# Testing
npm test                     # Offline, hermetic unit suite (Vitest)
npm run test:watch           # Auto-rerun tests on changes
npm run test:ui              # Open Vitest UI
npm run test:coverage        # v8 coverage, thresholds at 100% on all metrics
npm run test:live            # Live end-to-end suite — needs `npm run build` and the network; fails without a build
npm run type-check           # TypeScript validation only (both tsconfig projects)

# Gates and release
npm run spellcheck           # cspell over *.md and *.ts
npm run format:check         # Prettier check
npm run check:manifest       # manifest.json tools/version must match the tool classes
npm run sync:manifest        # Rewrite manifest.json from createTools()
npm run check                # build, then the static + test gates: type-check, lint, format, spelling, manifest, tests + 100% coverage
                             # (not npm audit, reuse lint or test:live — run those separately)
npm run release              # (clean git clone, REUSE 6.2.0, CHANGELOG entry dated today) npm ci → check (builds first) → reuse lint → npm audit --omit=dev → npm ci --omit=dev → mcpb pack → npm pack → npm ci
npm run docker:build         # docker build with the version, revision and build-time labels filled in

# Maintenance
npm run clean                # Remove dist/ and coverage/
```

## Project Structure

```
├── src/
│   ├── docs-server.ts             # stdio entry point (thin; excluded from coverage)
│   ├── docs-server-http.ts        # Streamable HTTP entry point (thin: env, listen, timeouts, signals, exit codes)
│   ├── server.ts                  # createServer() / createTools(): installs all tools, registers resources
│   ├── version.ts                 # SERVER_NAME / SERVER_VERSION read from package.json
│   ├── config/
│   │   ├── constants.ts           # Grouped frozen dicts: DOCS, FETCH, CACHE, LIMITS, HTTP + isAllowedDocUrl
│   │   └── env.ts                 # Env parsers, ENV_DEFAULTS, readEnv(), ENV, VERBOSE
│   ├── http/
│   │   └── app.ts                 # createHttpApp(): all HTTP request handling (stateless transport per POST,
│   │                              #   per-client shares, request queue, cancellation, /health, /ready)
│   ├── utils/
│   │   ├── http-client.ts         # Shared fetch pipeline: LRU cache (200 / 5 MB), revalidation, retry, caps,
│   │   │                          #   bounded priority queue, outage memo, per-client fetch budget
│   │   ├── request-context.ts     # Per-request abort signal + client key (AsyncLocalStorage)
│   │   ├── http-security.ts       # Host allowlist, CORS policy, trusted proxies, client IP, rate-limit key
│   │   ├── page-links.ts          # webPageLinks / webPageUrls: page links as the web pages people open, not .md
│   │   ├── calls-in-flight.ts     # The MCP calls running now, which the stdio entry finishes before it exits
│   │   ├── jsonrpc-lines.ts       # JsonRpcLineGuard: stdin lines checked before the transport, bad requests answered
│   │   ├── quote.ts               # quoteArgument: an argument echoed back on one line, at most 120 characters
│   │   ├── clock.ts               # withinLast / stillAhead: wall-clock windows safe against a clock step back
│   │   ├── errors.ts              # errorMessage(err), errorLine(err): an error as one log line, messageLabel(message),
│   │   │                          #   protocolErrorLine(): a protocol error's stderr line, folded and capped
│   │   └── logger.ts              # VERBOSE-gated stderr diagnostics (tool invocations)
│   ├── docs/
│   │   ├── docs-index.ts          # llms.txt parsing, URL-derived sections, word-based ranking
│   │   ├── document.ts            # normalizeDocRef, getDocument, sliceDocument (paging)
│   │   ├── full-text.ts           # llms-full.txt page splitting, URL attachment, excerpt search
│   │   ├── source-memo.ts         # Per-source memo with revalidation and stale-on-failure
│   │   ├── markdown.ts            # CommonMark line scanner (fences, indented code, list indents, headings) + heading-anchor stripping
│   │   ├── code-examples.ts       # Code block extraction (fenced or indented) + language aliases
│   │   └── updates.ts             # "Last updated" date parsing (UTC) for recency tracking
│   ├── resources/
│   │   └── llms-index-resource.ts # llms.txt indexes exposed as MCP resources
│   └── tools/                     # base-tool.ts, source-report.ts, output-schemas.ts, one BaseTool subclass per tool (8)
├── test/                          # Mirrors src/ (config/, docs/, http/, resources/, tools/, utils/)
│   ├── setup.ts                   # Clears server env vars, blocks real network fetches
│   ├── helpers.ts                 # In-memory MCP client + seeded fixtures + stubFetch
│   ├── manifest.test.ts           # manifest.json tools == createTools()
│   ├── built-bundle.test.ts       # Offline: the BUILT stdio bundle lists the same tools and resources as src/ (skipped without dist/)
│   └── integration.test.ts        # Live, opt-in (LIVE_DOCS_TESTS=1): the BUILT stdio bundle against the live files
├── scripts/                       # clean.js, prepare.js, release.js (+ changelog.mjs, its CHANGELOG check, and release-files.mjs,
│                                  #   its checkout checks), inspect-http.mjs, live-tests.mjs, sync-manifest.mjs, docker-build.mjs
├── rollup.config.js               # Two bundles: docs-server.esm.js, docs-server-http.esm.js
├── vitest.config.ts               # setup file, timeouts, 100% thresholds, entry points excluded
├── Dockerfile                     # Multi-stage, user node, HTTP entry, HEALTHCHECK
└── manifest.json                  # MCP Bundle manifest (tools synced from the code)
```

## Core Architecture

- **No bundled content**: everything is fetched at runtime from
  `https://developer.magiclane.com` via the published `llms.txt` / `llms-full.txt`
  files, through one shared HTTP pipeline (`src/utils/http-client.ts`): at most
  6 concurrent fetches (7 while a client holds a slot it borrowed when alone, the extra one for a client running nothing yet; a client starts at most 4 page fetches while another waits, all but one when alone; the last free slot is kept for a client running nothing yet while fewer than three clients run pages, while a fetch hangs, for 60 s after a fetch timed out, and while a borrowed slot is held;
  the probes' reloads run 2 at a time after the calls' fetches, one with no answer for 5 s handing its turn on and
  running beside the slots, 2 at most) with a queue of 64 page fetches, 16 per client (beyond:
  "busy, retry"; index and full-text files jump the queue, are never refused
  and never charged), at most 20 s waiting for a slot, 20 s for the answer
  and 30 s in all from enqueue (50 s for the pages of a read_docs_batch call of more than 4 pages, or over HTTP
  until the call's request budget ends when that is later; a probe's
  background reload waits 30 s for a slot and takes 50 s in all), the single
  retry on a quick 5xx/network error included (a timeout is not retried); an HTTP call stops waiting for its
  pages 55 s after its request arrived (`FETCH.requestBudgetMs`); in-flight
  de-duplication, a 10 MB response cap (bodies over 512 KB served but not
  cached), HTML responses
  refused, redirects re-checked per hop against `isAllowedDocUrl` (HTTPS,
  exactly `developer.magiclane.com`, default port, no credentials), 404s
  remembered for 60 s and an unreachable host for 30 s, a stale copy served
  after 5 s of a slow refresh, a per-HTTP-client budget of 120 uncached page
  fetches per minute (reserved when the fetch is queued, given back if it never
  starts), outbound slots handed out
  round-robin across clients, and an LRU page cache of 200 entries / 5 MB (bytes) with
  a 1-hour TTL and ETag/Last-Modified revalidation. Indexes and full text are
  memoized separately per source (`src/docs/source-memo.ts`, 1 h TTL, served
  stale when a refresh fails or is slow, failures remembered for 30 s); raw
  full-text bodies are not kept — only parsed pages.
- **Request context**: `src/utils/request-context.ts` carries the request's
  abort signal and HTTP client key (AsyncLocalStorage). `BaseTool.installTo`
  runs `run()` inside it with the SDK's `extra.signal`, so a cancelled request
  (HTTP client disconnected; over stdio, `notifications/cancelled`) stops
  waiting for fetches and a shared download is aborted once nobody waits for
  it.
- **Class-based tools**: every tool is a class extending the abstract
  `BaseTool` (`src/tools/base-tool.ts`). `installTo(server)` centralizes
  registration, VERBOSE invocation logging, and a try/catch that converts any
  exception from `run()` into an `isError` MCP result — tool classes only
  implement `run()`. `createTools()` in `src/server.ts` is the single tool list.
- **Doc sources are data**: `DOCS.sources` in `src/config/constants.ts` drives the
  `source` enums of the tools, the MCP resources, and the test fixtures. Adding
  an SDK is one config entry. Sections are derived from page URLs
  (`deriveSection`) because the published indexes have no headings.
- **Bounded everything**: `LIMITS` caps query length (300) and scored words
  (16), reference length (500), filter length (64), `read_doc` slices and
  `get_code_examples` budgets (24,000 default / 50,000 max; longer code blocks
  come in parts), batch budget (120,000 over up to 20 pages, a failed page's
  share going to the others), `list_docs` pages (50 default / 100 max). `HTTP`
  caps the transport (256 KB body, 15 s body deadline, 16 MB in-flight bodies
  and 1 MB per client, 32 concurrent requests and 4 per client with a queue of
  64 waiting up to 10 s, 300 req/60 s per client with `search_docs` and
  `find_across_sdks` counting 5; a weighted call over the limit keeps only the
  1 counted on arrival, one refused for another reason — 503 busy — has been
  counted in full; `/health` and
  `/ready` count in a probe window of their own per client). `initialize`,
  `ping`, the list methods and notifications never wait for a slot, nor do
  `list_docs` and `find_across_sdks` once the indexes they need (and, for
  `find_across_sdks`, every page-contents file) are in memory.
  `/health` (liveness, the Docker HEALTHCHECK) is 503 only while shutting
  down: 200 "degraded" (with reasons) while slots, the outbound queue or the
  body budget are full — a refusal for the body budget keeps it for 10 s —,
  while the site hangs (`fetchesHanging()`: a fetch over 5 s, or a timeout in
  the last 60 s with no answer since, whatever its status), or documentation files could not be refreshed (`upstream.failing`, from
  `SourceMemo.failing()`; a downloaded file that holds no pages counts as a
  failed load), 200 "saturated" while the request queue is full, 200
  "starting" until the first index has loaded (the HTTP entry point starts
  that load) and 200 "unavailable" while none is loaded and loading one
  fails. `/ready` (readiness) answers the same body, 503 also while
  saturated, starting or unavailable.
  The HEALTHCHECK port rule repeats `readEnv`'s; `test/dockerfile.test.ts`
  keeps them equal.
- **Failed sources are reported, not hidden**: `loadIndex` /
  `loadFullTextSections` return `{ ..., failed }` with each failure's `part`
  (`index` or `full-text`); an index that parses to no pages counts as failed.
  `search_docs`, `list_docs` and `list_recent_updates` append the "## Sources
  not loaded" block (`src/tools/source-report.ts`, which tells an empty file
  from an unreachable host), `find_across_sdks` marks the source inline, all
  four return `failedSources` in structured output, and every one returns an
  error only when nothing requested loaded. Never turn a network
  failure into an empty result. `loadFullTextSections(ids, indexLoad)` takes
  an index load already in flight, so a call loads each index once.
- **Stateless HTTP**: `src/http/app.ts` creates a fresh server/transport pair
  per `POST` (`sessionIdGenerator: undefined`). No session ids, no GET stream
  (405), no session table. The entry point `src/docs-server-http.ts` only reads
  `ENV`, sets `node:http` timeouts, and exits 1 on a failed listen or an
  uncaught exception.
- **Validation**: Zod at the tool boundary; invalid arguments surface to MCP
  clients as `isError` results, not thrown errors.
- **Magic Lane only**: `createServer()` passes server-level MCP `instructions`
  pinning clients to developer.magiclane.com, and `normalizeDocRef` rejects any
  other host — never weaken either.
- **Identity**: `SERVER_NAME` is the npm package name (`@magiclane/mcp-docs-server`),
  used for `serverInfo`, `/health` and the User-Agent (flattened to
  `magiclane-mcp-docs-server/<version>`). The CLI commands are
  `mcp-docs-server` (named after the package, so `npx -y @magiclane/mcp-docs-server` runs it) and
  `magiclane-mcp-docs` for stdio, and `magiclane-mcp-docs-http`. A client configuration in the docs
  names `magiclane-mcp-docs` (`test/package.test.ts`).

### Tool Implementation Pattern

```typescript
// 1. Define the Zod input schema at module level (bounds from LIMITS), then extend BaseTool
const InputSchema = z.object({
  query: z.string().min(1).max(LIMITS.maxQueryChars).describe('What to look up.'),
});
type Input = z.infer<typeof InputSchema>;

export class ExampleTool extends BaseTool<typeof InputSchema> {
  readonly name = 'example_tool';
  readonly description = 'Tool description shown to the model.';
  readonly annotations: ToolAnnotations = { ...READ_ONLY_ANNOTATIONS, title: 'Example tool' };

  constructor() {
    // Pass outputSchema too for structured content — and then put the WHOLE
    // result in it: some clients show the model only the structured content.
    super({ inputSchema: InputSchema });
  }

  async run(rawInput: unknown): Promise<CallToolResult> {
    const { query } = rawInput as Input; // already validated by the SDK against InputSchema
    const result = await getExampleContent(query); // 3. docs-layer function in src/docs/
    return this.textResponse(result); // markdown text — NOT JSON.stringify
    // failures: return this.errorResponse('...'); thrown errors are caught by installTo
  }
}

// 2. Register the tool by adding it to createTools() in src/server.ts:
//      new ExampleTool(),
//    then run `npm run sync:manifest` so manifest.json lists it.
```

## Code Style Guidelines

- TypeScript strict mode; pure ESM (`"type": "module"`, `module: node20` with node16-style resolution — local
  imports need the `.js` extension).
- Kebab-case filenames (`http-client.ts`, `get-document-tool.ts`).
- SPDX header (`Apache-2.0`, Magic Lane International B.V.) at the top of every source, test and script
  file (`scripts/*.js|mjs` included); `REUSE.toml` covers configuration files that cannot carry one.
- Prettier owns formatting (120 columns, single quotes, `es5` trailing commas); ESLint flat config with
  `typescript-eslint` recommended.
- No `console.log` in the stdio path — stdout is the MCP protocol; log to stderr only.
- Diagnostics go through `src/utils/logger.ts` (`logVerbose` / `logToolInvocation`),
  gated by the `VERBOSE` env flag (default `false`) and always written to stderr.

## Development Workflow

When adding a new tool:

1. Create `src/tools/<name>-tool.ts` exporting `class <Name>Tool extends BaseTool`
   (see the Tool Implementation Pattern above). If it reads indexes or full
   text, keep the failed-source invariant (`sourceFailureNote` /
   `allSourcesFailedMessage`).
2. Add `new <Name>Tool()` to `createTools()` in `src/server.ts`.
3. Add `test/tools/<name>-tool.test.ts` using `connectClient()` + `seedFixtures()`
   from `test/helpers.ts` — tests must run offline against the seeded fixtures.
4. Update the exact tool list in `test/server.test.ts`, run `npm run sync:manifest`
   (checked by `test/manifest.test.ts` and `npm run check`; `test/built-bundle.test.ts`
   compares the built bundle's tools and resources with the sources, so rebuild
   before `npm test`), and update the README (tool section + intro bullet).
5. Run `npm test` and `npm run test:coverage` — keep coverage at 100%; remove
   provably dead branches instead of writing tests for unreachable code.

When adding a doc source: extend `DOC_SOURCES` in `src/config/constants.ts`, seed a
fixture in `test/helpers.ts` (`seedFixtures`), and update the resource-count
tests and README tables.

## Testing Instructions

- **Run tests frequently**: use `npm test` after making changes.
- **Watch mode**: use `npm run test:watch` for continuous testing.
- **Coverage reports**: use `npm run test:coverage` — thresholds enforce 100% on
  all metrics, so a drop fails the run. `src/docs-server.ts` and
  `src/docs-server-http.ts` are excluded (thin entry points).
- **Test organization**: `test/` mirrors `src/` (config/, docs/, http/,
  resources/, tools/, utils/) — every module gets a same-named test file, except
  the two entry points (`docs-server.ts`, `docs-server-http.ts`) and the three
  small helpers tested through their callers (`docs/markdown.ts` in
  `code-examples.test.ts`, `tools/source-report.ts` and the schema pieces of
  `tools/output-schemas.ts` in the tool tests, which validate every structured
  result against them). Repository-wide checks live at the top of `test/`
  (`built-bundle`, `dockerfile`, `manifest`, `licensing`, `vscode`, `changelog`, `release-files`, `integration`).
- **Hermetic**: `test/setup.ts` deletes every server env var and replaces
  `fetch` with a guard that throws on any real network request. Seed fixtures
  or stub `fetch`: `stubFetch` in `test/helpers.ts` replaces `globalThis.fetch`
  itself, so undo it with the `restore()` it returns (`vi.unstubAllGlobals()`
  does not); undo `vi.stubGlobal` with `vi.unstubAllGlobals()` in `afterEach`.
- **Focus on edge cases**: test validation failures, error handling, HTTP
  failures (404/500/timeouts/HTML answers), paging boundaries, failed sources
  and empty results — not just the happy path.
- Unit tests run the REAL server against a REAL MCP client over
  `InMemoryTransport`; the HTTP app is tested over a REAL `node:http` server on
  an ephemeral port (`test/http/app.test.ts`) with an injectable clock.
- `npm run test:live` sets `LIVE_DOCS_TESTS=1` and runs `test/integration.test.ts`,
  which spawns `dist/docs-server.esm.js` against the live docs site (every
  index loads and lists its pages, the page contents split into those pages
  with a URL on every excerpt, a missing page is a tool error, and the longest
  page reads to its end); it fails (does not skip) when `dist/` is
  missing. `npm test` never touches it: `vitest.config.ts` leaves the file out
  unless `LIVE_DOCS_TESTS` is set, so it is not even listed as skipped. The offline `test/built-bundle.test.ts`
  spawns the same bundle without the network and checks its tool and resource
  listings against the sources; `npm run check` builds first, so there it
  always runs; a bare `npm test` without `dist/` skips it (the warning shows
  with the verbose reporter only).
- Timeouts come ONLY from `vitest.config.ts` (`testTimeout: 60_000`), apart from
  the 15 s limit of the `waitFor` helper in `test/http/app.test.ts`, which polls
  and returns as soon as its condition holds. A test that needs time to pass
  uses fake timers or `vi.waitFor`; never a wall-clock sleep.

## Security & Best Practices

- **Input validation**: all parameters validated and bounded via Zod schemas and `LIMITS`.
- **Honest errors**: tool error texts carry the upstream reason (the documentation is public, nothing to leak); never report a network failure as "no documentation".
- **No authentication**: the HTTP transport has none — bind to localhost (default) or front it with a reverse proxy. `MCP_CORS_ORIGIN=*` lets any web page call a local instance; prefer an explicit origin list.
- **Type safety**: strict TypeScript compilation, runtime validation.
- **Pure where it matters**: `http/app.ts`, `http-security.ts`, ranking and slicing are pure functions of their inputs.

## Important Files

- `src/server.ts` — `createServer()` / `createTools()`: tool registration,
  server-level instructions, MCP resources
- `src/http/app.ts` — `createHttpApp()`: the whole HTTP request surface
- `src/tools/base-tool.ts` — abstract base class for all tools
  (`installTo`, `run`, `textResponse`/`errorResponse`, `READ_ONLY_ANNOTATIONS`)
- `src/tools/source-report.ts` — failed-source wording shared by the search/list tools
- `src/tools/output-schemas.ts` — shared output-schema pieces (page, failed sources)
- `src/tools/*-tool.ts` — individual tool implementations (one class per file,
  Zod input schema defined at module level in the same file)
- `src/docs/` — core documentation logic: index parsing/ranking, page
  normalization and slicing, full-text pages and excerpts, source memo,
  markdown helpers, code-example extraction, recency tracking
- `src/utils/http-client.ts` — shared HTTP pipeline (native `fetch`): cache,
  retry, dedup, concurrency cap, size caps, HTML refusal, manual redirect validation
- `src/utils/http-security.ts` — Host/Origin validation, trusted proxies and
  client IP handling for the HTTP transport
- `src/utils/request-context.ts` — per-request abort signal, client key and
  work tracking (AsyncLocalStorage) for cancellation and per-client budgets
- `src/utils/page-links.ts` — `webPageLinks()` / `webPageUrls()`: every page link a
  tool returns, in text or structured content, as the web page people open
- `src/utils/calls-in-flight.ts` — the MCP calls running now (`trackCall`,
  `callsSettled`, `callsSettledOrStalled`), which the stdio entry finishes before it exits
- `src/utils/jsonrpc-lines.ts` — `JsonRpcLineGuard` (the stdio lines checked before
  the transport reads them) and `invalidRequestError()` for the bad requests among them
- `src/utils/quote.ts` — `quoteArgument()`: an argument echoed back on one line
- `src/utils/clock.ts` — `withinLast()` / `stillAhead()`: wall-clock windows that a
  clock stepped back does not stretch
- `src/utils/errors.ts` — `errorMessage()`, `errorLine()` (an error as one log line,
  a zod error as its closest shape's issues), `messageLabel()`, `protocolErrorLine()`
  (the stderr line about a protocol error: the client's method and id folded and
  cut short, the whole line at most 300 characters)
- `src/utils/logger.ts` — stderr logger; verbose output gated by the `VERBOSE`
  env var (stdout is reserved for the MCP protocol)
- `src/config/constants.ts` — every fixed value as grouped frozen dictionaries
  (`DOCS`, `FETCH`, `CACHE`, `LIMITS`, `HTTP`) plus the `isAllowedDocUrl` policy
- `src/config/env.ts` — environment layer: parsers, `ENV_DEFAULTS`, `readEnv()`,
  the `ENV` snapshot and `VERBOSE`
- `src/version.ts` — `SERVER_NAME`/`SERVER_VERSION` read from package.json at runtime
- `test/setup.ts` / `test/helpers.ts` — hermetic guard; in-memory MCP client + seeded fixtures
- `scripts/sync-manifest.mjs` — keeps `manifest.json` tools in step with the tool classes
- `package.json` — dependencies, `bin` (`mcp-docs-server`, `magiclane-mcp-docs`, `magiclane-mcp-docs-http`), npm scripts;
  `files` ships `dist`, `src`, `LICENSES` and `REUSE.toml`; no `main`/`exports` (CLI package)
- `tsconfig.json` / `tsconfig.build.json` — editor+tests config vs. build config
  (strict mode, `noUncheckedIndexedAccess`; rollup disables declaration emit)
- `vitest.config.ts` — test configuration (setup file, timeouts, 100% coverage thresholds)

## Common Gotchas

- **Do NOT add a shebang to `src/docs-server*.ts`** — `rollup.config.js` prepends
  `#!/usr/bin/env node` via `banner`; a second shebang on line 2 is a SyntaxError.
- `node src/docs-server.ts` does not run — the sources are TypeScript with `.js`
  specifiers. Use `npm run dev` / `node --import tsx src/docs-server.ts`, or build.
- The MCP SDK client returns validation failures as `{ isError: true }` results,
  not rejected promises — assert on `result.isError`, not `.rejects`.
- `get_product_guide` section enums derive from `Object.keys(...)` of the
  `PRODUCTS` map in `src/tools/product-guide-tool.ts`; changing the map changes
  the tool schema — update tests, `manifest.json` (`npm run sync:manifest`) and
  the README together.
- A test that "simulates" an unreachable site by only clearing a cache does not
  reach the network (the `test/setup.ts` guard throws) — but the thrown guard
  error then reads as a failed source. Stub `fetch` to shape the failure you mean.
- `test/helpers.ts` fixtures must cover EVERY source in `DOC_SOURCES`, or tools
  defaulting to `source: all` will report those sources as not loaded.
- `npm start` does not read `.env`; use `node --env-file=.env <bundle>`.
- `manifest.json` `tools` and `version` are generated — edit the tool classes,
  then `npm run sync:manifest`; `npm run check` (and so `npm run release`)
  runs `npm run check:manifest`. There is no CI: run `npm run check` before
  committing a release.

## Environment Setup

```bash
# Node.js >= 22 required (ESLint 10 wants 22.13+)
npm install
npm run build
npm test
```

Configuration is environment-only. `.env.example` documents every variable and
its default; copy it to `.env` (git-ignored) and load it with Node 22's native
`--env-file=.env` — the project deliberately has no `dotenv` dependency.

All variables are read once by `readEnv()` in `src/config/env.ts` into the
typed `ENV` structure (`ENV.verbose`, `ENV.http.*`: `port`, `host`, `path`,
`corsOrigin`, `allowedHosts`, `dnsRebindingProtection`, `trustedProxies`,
`trustedProxyHops`). Add new variables THERE, never with a bare `process.env`
read in a module — `readEnv(source)` takes an injectable source, so it is
unit-testable without module resets. Add the variable to `SERVER_ENV_VARS` in
`test/setup.ts` and to `.env.example` too.

No API key or account is needed — the documentation served is public and the
server has no authentication of its own (see `docs/http-server-setup.md` for
deploying it behind a proxy).

## Packaging and Release

- License: Apache-2.0 (`LICENSE`, `REUSE.toml`, `LICENSES/Apache-2.0.txt`);
  `REUSE.toml` annotates the project's own files (top-level files and its folders, never `node_modules`, which ships
  beside it in the MCPB bundle and the image) as Apache-2.0. The third-party packages are covered by neither it nor
  `LICENSES/`: each package carries its own license file in `node_modules`; there is no third-party notices file.
- `npm run release` (`scripts/release.js`), from the top folder of a git clone or submodule with a clean working tree (an edited
  or untracked file stops it, and so does a tracked file marked skip-worktree or assume-unchanged, whose edits `git status`
  would not show: whatever is in the tree ships; a git-ignored file stops it only when an archive would take it — anything
  under `src/` or `LICENSES/` that npm would pack (not `.DS_Store` or `npm-debug.log`, but a nested `node_modules`), a root
  `README`, `COPYING` or `LICENSE` file of any extension (npm packs those whatever it is told), or any other path, at any
  depth, that `.mcpbignore` and mcpb's own exclusions do not drop; a new folder holding only ignored files is judged by
  those files (`scripts/release-files.mjs`, tested in `test/release-files.test.ts`) —
  so a local `.env`, logs and `.DS_Store` files are fine) (elsewhere — an archive, even one unpacked inside another
  repository — `reuse lint` also reads
  `node_modules`, `dist` and `coverage`, so the release stops first), and with `CHANGELOG.md` ready: its entry for the
  package version dated today, and nothing left under `## [Unreleased]` (`scripts/changelog.mjs`, tested in
  `test/changelog.test.ts`; entries wait there undated and get `## [<version>] — <date>` on the release day, so no date
  goes stale while commits keep coming; an HTML comment or a link definition is no entry, and the file's own notes sit
  above its first section, so none lands in a released one): `npm ci` → `npm run check` (which
  builds first, so the built-bundle check runs) → `reuse lint` with REUSE 6.2.0 (an installed copy of that version, or
  through uv or pipx; the release stops when none is available) → `npm audit --omit=dev` → `npm ci --omit=dev` →
  `npx -y @anthropic-ai/mcpb@2.1.2 pack . magiclane-mcp-docs-server-<version>.mcpb` →
  `npm pack` → `npm ci` (after steps 5–7 whether they succeed or fail; a
  failure in steps 1–4 stops the script before `node_modules` is changed). `.mcpbignore` keeps sources and tests out of the
  bundle; the npm tarball ships `dist/`, `src/`, `LICENSES/`, `REUSE.toml`,
  `README.md`, `LICENSE`, `package.json`. `manifest_version` is `"0.3"` (it
  declares `privacy_policies`, which 0.1 rejects).
- `npm run build` is rollup only (no declaration emit); importing the package
  is not supported.
- Docker: `npm run docker:build` (`scripts/docker-build.mjs`: `docker build`
  with the version, revision (`-dirty` for a modified tree) and build-time labels
  filled in, on `node:22-slim` pinned by digest, recorded in the `base.name`
  label); multi-stage, the runtime stage without npm/npx/corepack/yarn, runs as
  `node`, HTTP entry, `HEALTHCHECK` on `/health`, port from `MCP_HTTP_PORT`/`PORT`
  (default 3000), `MCP_HTTP_HOST=0.0.0.0` inside; publish as
  `-p 127.0.0.1:3000:3000`.
- Checks run locally — there is no CI and none is planned: `npm run check`
  (build, type-check, lint, format:check, spellcheck, check:manifest,
  test:coverage with 100% thresholds), plus `npm audit --omit=dev`,
  `reuse lint` and, when the site is reachable, `npm run test:live`.
- Do not state that the GitHub repository is public or that the package is on
  npm; write install instructions as "once published" or from a clone.

## When Working with Claude

- Read `src/config/constants.ts` first — the doc sources and limits explain most behavior.
- Prefer extending `DOC_SOURCES` over writing new fetch logic.
- Keep the test mirror intact: every `src/` module has a same-named `test/` file, except the two entry points and
  the three helpers tested through their callers (see Test organization).
- Run `npm run lint && npm test` before considering a change done; run
  `npm run format:check`, `npm run spellcheck` and `npm run check:manifest` before pushing.
- The README documents every tool with parameter tables and example prompts —
  keep it in sync with schema changes.
