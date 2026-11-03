# Magic Lane MCP Docs Server

The **Magic Lane MCP Docs Server** enables any AI agent or application to become a **Magic Lane documentation expert**. Through the [Model Context Protocol](https://modelcontextprotocol.io), your AI assistant gains instant, searchable access to the live [Magic Lane developer documentation](https://developer.magiclane.com/docs): the developer guides (account setup, API keys, Map Studio, the Magic Lane MCP Server), the full references of the **Maps SDKs for Flutter, Android, iOS, C++, and TypeScript** (maps & 3D scene, markers, places & search, routing & navigation, positioning, offline maps, weather, fleet management, migration guides), and the **Cloud REST APIs** (Routing, Isochrones, Search, Reverse Geocoding, Fleet Management, Geofences, Vector Tiles, Offline Maps).

- **Documentation Search** - Rank pages across all documentation sources, with optional full-text excerpts
- **Document Retrieval** - Fetch any documentation page as clean markdown, paged for long pages
- **Batch Retrieval** - Pull up to 20 pages in a single call
- **Documentation Browsing** - List every documented page grouped by source and section
- **Code Example Extraction** - Pull only the code blocks from a page, filterable by language
- **Cross-SDK Lookup** - Find the same topic in every SDK side by side
- **Recency Tracking** - List which pages changed in the last N days
- **Product Guides** - Serve the official Magic Lane MCP Server and Magic Lane Studio (formerly Map Studio) documentation

Documentation is fetched at runtime from Magic Lane's published [`llms.txt`](https://developer.magiclane.com/docs/llms.txt) / [`llms-full.txt`](https://developer.magiclane.com/docs/llms-full.txt) files - nothing is bundled, so results always reflect the live docs. All requests go through one outbound pipeline with a one-hour in-memory cache that revalidates with ETag / Last-Modified (an expired entry is renewed with a cheap 304 instead of a re-download, and is served stale when the refresh fails) and retries a failed (5xx or network) request once. Every tool is annotated read-only and idempotent; whether a client still asks before calling a tool is up to the client.

No API key or account is required, and the server has no authentication of its own: the documentation it exposes is public.

## Use the hosted server

Magic Lane runs this server at **https://developer.magiclane.com/docs-mcp** (Streamable HTTP, no API key), so you can connect your AI client without installing anything. In Claude Code:

```bash
claude mcp add --transport http --scope user magiclane-docs https://developer.magiclane.com/docs-mcp
```

The [setup guide](https://developer.magiclane.com/docs/guides/mcp-docs-server/) shows the same for Cursor, VS Code and other clients. To run the server yourself, read on.

## Getting Started

### Prerequisites

- **Node.js 22+** and **npm** - verify with:

  ```bash
  # Check Node.js version (should be 22+)
  node --version

  # Check npm version
  npm --version
  ```

  The server itself runs on any Node.js 22 (`engines: >=22`); the development toolchain (ESLint 10) needs Node.js 22.13 or newer. The `inspect:*` scripts pin the MCP Inspector to 1.0.2, the last release that runs on Node.js 22.18 (Inspector 2.x needs 22.19+).

- An **MCP-compatible AI client**, such as:
  - [Claude Desktop](https://claude.ai/download)
  - [Cursor IDE](https://cursor.com/)
  - [Visual Studio Copilot](https://visualstudio.microsoft.com/github-copilot/)
  - **Visual Studio Code** with [GitHub Copilot](https://github.com/features/copilot) or [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)
  - **Android Studio** with [GitHub Copilot](https://github.com/features/copilot)

- No API key or account - the documentation this server exposes is public

### Installation

Once the package is published, `npx` runs it without an install - the way most MCP client configurations start a server:

```bash
npx -y @magiclane/mcp-docs-server                                           # stdio transport
npx -y -p @magiclane/mcp-docs-server magiclane-mcp-docs-http                # Streamable HTTP on http://127.0.0.1:3000/mcp
```

The first form runs the command named after the package, `mcp-docs-server`
(the stdio server). The HTTP server is another command of the same package,
so `npx` needs `-p` and the command's name.

For a service, run the HTTP server from a global install or from Docker, not
through `npx`: `npx` starts the server under npm, so a signal the supervisor
sends (`SIGTERM` from `systemd` or `docker stop`) may not reach it, and the
calls still running then end with the process instead of finishing.

A global install provides the commands `magiclane-mcp-docs` (stdio) and `magiclane-mcp-docs-http` (Streamable HTTP), the names to use in a client configuration:

```bash
npm install -g @magiclane/mcp-docs-server
magiclane-mcp-docs          # stdio transport
magiclane-mcp-docs-http     # Streamable HTTP transport on http://127.0.0.1:3000/mcp
```

From a clone of the repository:

```bash
git clone https://github.com/magiclane/magiclane-mcp-docs-server.git
cd magiclane-mcp-docs-server

# Install dependencies
npm install

# Build the two bundles
npm run build

# Verify the build was successful
ls dist/  # docs-server.esm.js and docs-server-http.esm.js (plus source maps)
```

Client configurations that start the server with `node` need two absolute paths: the bundle (`/absolute/path/to/magiclane-mcp-docs-server/dist/docs-server.esm.js`) and, for some clients, `node` itself - `which node` on macOS/Linux, `where node` on Windows. With the package installed globally, the `magiclane-mcp-docs` command replaces both.

The npm package ships `dist/` (the two bundles and their source maps), `src/` (the TypeScript sources, for reference), `LICENSES/`, `REUSE.toml`, `README.md`, `LICENSE` and `package.json` - no type declarations. It is a CLI package: it has no `main`/`exports`, so importing it from another program is not supported.

### Running the Server

**Stdio transport (default - used by desktop MCP clients):**

```bash
npm start            # node dist/docs-server.esm.js (after npm run build)
# or during development, straight from the TypeScript sources:
npm run dev          # node --import tsx src/docs-server.ts
```

A one-shot pipe works too - requests on stdin, then the end of input (`printf '…' | npx -y @magiclane/mcp-docs-server`): the calls still running when stdin closes finish, and their answers are written before the server exits. Each request to the documentation site is waited for on its own limits, so an answer whose first byte takes up to 20 s still arrives; the first request the site leaves unanswered for 20 s stops further requests, and the calls answer with what they have. Calls still running after 3 s with nothing left to wait for from the site are given up. The exit status is 0 when every call was answered, 1 when some were given up.

**Streamable HTTP transport:**

```bash
npm run start:http   # node dist/docs-server-http.esm.js (after npm run build)
# or during development:
npm run dev:http     # node --import tsx src/docs-server-http.ts
```

`node src/docs-server.ts` does **not** work (the sources are TypeScript with `.js` import specifiers); use the built bundle or `node --import tsx`.

The HTTP server listens on `http://127.0.0.1:3000/mcp` by default and exposes separate `GET /health` (liveness) and `GET /ready` (readiness) endpoints. Its port, bind address, path, CORS policy, Host allowlist and trusted proxies are set through environment variables, and it enforces body, rate and concurrency limits with a share per client - all documented in [HTTP server › Configuration](https://github.com/magiclane/magiclane-mcp-docs-server/blob/HEAD/docs/http-server-setup.md#configuration), together with loading a `.env` file. Every variable and its default is also listed in [`.env.example`](https://github.com/magiclane/magiclane-mcp-docs-server/blob/HEAD/.env.example). Two settings deserve care:

- **`MCP_CORS_ORIGIN=*`** lets any web page the user visits call a local instance from their browser - the server has no authentication. Allow your web client's exact origin instead.
- **Behind a reverse proxy**, `X-Forwarded-For` is honoured only from the proxy addresses listed in **`MCP_TRUSTED_PROXIES`** (IPs or CIDR ranges) _and_ with `TRUSTED_PROXY_HOPS` > 0. With `TRUSTED_PROXY_HOPS` alone the header is ignored and every client shares the proxy's rate-limit bucket and concurrency share.

Both transports honour `VERBOSE`:

```bash
VERBOSE=true npm start        # logs "[Magic Lane MCP Docs] tool invoked: <name>" per call
```

On the stdio transport every diagnostic goes to **stderr** - stdout is reserved for the MCP protocol - so verbose mode is safe to enable. (The HTTP entry point, which has no protocol on stdout, prints its startup banner there.) Accepted truthy values are `true`, `1`, `yes`, and `on` (case-insensitive); anything else is off.

### Connecting a Client

Every guide uses the client config key `magiclane-docs` and the same server; only the file and its schema differ:

| Client                                        | Config file                                                | Schema                      | Guide                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| VS Code (GitHub Copilot)                      | `.vscode/mcp.json` or the user `mcp.json`                  | `servers` + `type`          | [VS Code guide](https://github.com/magiclane/magiclane-mcp-docs-server/blob/HEAD/docs/vscode-setup.md#mcp-client-setup-github-copilot)  |
| Claude Desktop                                | `claude_desktop_config.json`, or the `.mcpb` bundle        | `mcpServers`                | [Claude Desktop guide](https://github.com/magiclane/magiclane-mcp-docs-server/blob/HEAD/docs/claude-desktop-setup.md)                   |
| Claude Code                                   | `claude mcp add …` or `.mcp.json`                          | `mcpServers`                | [VS Code guide › Claude Code](https://github.com/magiclane/magiclane-mcp-docs-server/blob/HEAD/docs/vscode-setup.md#claude-claude-code) |
| Visual Studio (GitHub Copilot)                | `%USERPROFILE%\.mcp.json` or `<SolutionDir>\.mcp.json`     | `servers` + `type`          | [Visual Studio guide](https://github.com/magiclane/magiclane-mcp-docs-server/blob/HEAD/docs/vs-setup.md)                                |
| Android Studio / JetBrains (Copilot plugin)   | the plugin's `mcp.json` (Copilot → Model Context Protocol) | `servers` + `type`          | [Android Studio guide](https://github.com/magiclane/magiclane-mcp-docs-server/blob/HEAD/docs/androidstudio-setup.md)                    |
| Cursor                                        | `.cursor/mcp.json`                                         | `mcpServers`                | [Cursor guide](https://github.com/magiclane/magiclane-mcp-docs-server/blob/HEAD/docs/cursor-setup.md)                                   |
| Any client, over HTTP (shared server, Docker) | the client's own HTTP/URL entry                            | `"type": "http"` or `"url"` | [HTTP server guide](https://github.com/magiclane/magiclane-mcp-docs-server/blob/HEAD/docs/http-server-setup.md)                         |

### MCP Inspector

```bash
npm run inspect:build        # build, then inspect the stdio server
npm run inspect:dev          # inspect the stdio server from TypeScript sources
npm run inspect:build:http   # build, start the HTTP server, and launch the inspector
npm run inspect:dev:http     # same, from TypeScript sources
```

> Each script tells the Inspector which transport to open on (`--transport stdio` for the stdio pair), because the Inspector otherwise opens on whatever transport was used last in that browser: after an HTTP session, a stdio launch would come up on "Streamable HTTP" and Connect would fail with `ECONNREFUSED 127.0.0.1:3000`, as no HTTP server is running. The HTTP variants start the server and point `scripts/inspect-http.mjs` at it (`MCP_HTTP_URL`, default `http://127.0.0.1:3000/mcp`); the launcher waits until the server accepts connections (up to `MCP_HTTP_WAIT_MS`, default 60 s) before it opens the Inspector, which connects as soon as its page loads. No credentials are involved - connect and start calling tools.

---

## Available Tools

### 1. Documentation Search (`search_docs`)

Search the Magic Lane developer documentation. Ranks pages from the `llms.txt` indexes (title, section, description, path) and optionally appends full-text excerpts from `llms-full.txt`.

**Ranking:** whole words in any script, function words removed and word forms folded ("route calculation" finds "Calculate Route"). Rare words weigh more, action words less; pages score by query coverage, with bonuses for adjacent words, the whole phrase and an exact title. A platform in the query limits the search to that source, unless it is part of a feature name ("Android Auto"); everyday platform words (_web_, _cloud_, _rest_, _compose_) only rank that platform higher. Up to 5 full-text excerpts with page URLs follow the index results.

**Structured output** (`structuredContent`), for programmatic consumers:

- `results[]` - index matches, best first: `title`, `url`, `path`, `description`, `source`, `section`
- `excerpts[]` - full-text matches, best first: `title`, `url?`, `path?`, `source`, `excerpt` (empty when `includeFullText` is `false`)
- `failedSources[]` - `{ source, part, reason, kind }` for every file that could not be loaded (`kind`: `unreachable` or `file`); `part` is `index` (the source's pages were not ranked) or `full-text` (no excerpts from it)
- `searched?` - `{ query, sources }`, present when a platform name in the query narrowed the search or left the search words: what was searched - the query without the platform name, or the whole query when nothing else matched there and the platform's overview page names the topic ("rest api authentication") - and where: the platform's pages, plus the developer guides for an API-key question ("rest api key")
- `preferred?` - the sources ranked higher because the query says _web_, _cloud_, _rest_ or _compose_ without _sdk_/_api_ (every source is still searched)
- `unverified?` - `{ word, source }` for a platform word left out of the search words that could not be checked against its platform's page titles (that index did not load), so it may be part of a feature name ("Android Auto") instead
- `elsewhere?` - when the topic matches no page of the platform the query names: the other sources whose best page for it is titled with a word of it

**Input Parameters:**

| Parameter         | Type                                                                                                 | Default    | Description                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------- |
| `query`           | string (1–300 chars)                                                                                 | _required_ | Free-text search query, e.g. `"draw route on map"`            |
| `source`          | `all` \| `developer` \| `flutter` \| `android` \| `ios` \| `cpp` \| `typescript` \| `cloud-rest-api` | `all`      | Restrict the search to one documentation source               |
| `limit`           | number (1–25)                                                                                        | `8`        | Maximum number of index results (excerpts are capped at 5)    |
| `includeFullText` | boolean                                                                                              | `true`     | Also search full page contents (`llms-full.txt`) for excerpts |

**Example Prompts:**

- _"How do I calculate a route between two coordinates with the Flutter SDK?"_
- _"How do I stream turn-by-turn navigation over BLE with the Android SDK?"_
- _"Show me how to center the map on a coordinate in SwiftUI (iOS SDK)"_
- _"How do I embed an interactive map in a web app with the TypeScript SDK?"_
- _"Where do I get a Magic Lane API key?"_
- _"How do I download map data for offline use?"_
- _"Find docs about weather forecasts along a route"_
- _"How do I create a geofence and get alerts when an asset enters it?"_ (`source: cloud-rest-api`)

Fetch the markdown content of a specific documentation page by URL or `/docs/...` path. The whole page is reachable: a call returns 24,000 characters by default (`maxChars` up to 50,000), and every response starts with a note that says where you are - `(Complete page: N characters.)` or `(Showing characters a–b of N. M remain - call again with offset: b for the next chunk.)`. An `offset` past the end of the page is an error. Slices never split a surrogate pair, and always advance (even `maxChars: 1` at an emoji).

Accepted references (at most 500 characters), all normalized to `https://developer.magiclane.com/docs/<path>.md`:

- `/docs/flutter/examples/maps-3dscene/hello-map` (a docs path; `.md` is added, `.html` is replaced)
- `/flutter/examples/maps-3dscene/hello-map` (a path without the `/docs` prefix)
- `developer.magiclane.com/docs/...` (bare host) and `http://developer.magiclane.com/...` (upgraded to `https`)
- Query strings and fragments are stripped; letter case, doubled slashes and percent-encoded letters are folded (every published path is lower-case), so each page has one cache entry

Other hosts, non-default ports, URLs carrying credentials and other schemes (`ftp:`, `file:`, …) are refused, and so is `llms-full.txt` (megabytes; use `search_docs` and the pages instead). A path that the site answers with HTML (its shell or a 404 page) is rejected with "Not a documentation page".

**Input Parameters:**

| Parameter  | Type                 | Default    | Description                                                                  |
| ---------- | -------------------- | ---------- | ---------------------------------------------------------------------------- |
| `url`      | string (1–500 chars) | _required_ | Absolute `developer.magiclane.com` URL or a `/docs/...` path                 |
| `offset`   | number (≥0)          | `0`        | Character offset to start from (for paging through long pages)               |
| `maxChars` | number (1–50,000)    | `24000`    | Maximum characters to return from the offset; the note names the next offset |

**Example Prompts:**

- _"Read the Get Started guide from the Magic Lane docs"_
- _"Fetch https://developer.magiclane.com/docs/flutter/examples/routing-navigation/calculate-route.md and summarize it"_
- _"Open /docs/guides/map-studio and explain how to publish a custom style"_
- _"Read /docs/android/examples/ble/ble-server-client and explain the GATT service it publishes"_
- _"Fetch the Flutter route-preferences guide and list every vehicle profile option"_
- _"Open the Routing API guide from the Cloud REST APIs and show the request format"_
- _"Read /docs/typescript/examples/get-started-with-sample-apps and tell me the prerequisites"_

### 3. Batch Document Retrieval (`read_docs_batch`)

Fetch up to 20 documentation pages in a single call: at most 20 URLs are accepted, a longer array is refused with that limit, and one of 256 values or more is refused outright by the server's argument-size check, without naming it. The page text is capped at 120,000 characters shared across the pages that loaded (each gets at least 2,000; a failed or short page leaves its share to the others; each page's header and any error notes come on top); a page that was cut short says where to continue with `read_doc` (`offset`). Pages that fail to load are reported individually, and those that did not load in time are listed at the end, to read again with another call; the call is an error only when every page failed. A page given twice is returned once.

**Input Parameters:**

| Parameter | Type            | Default    | Description                                                   |
| --------- | --------------- | ---------- | ------------------------------------------------------------- |
| `urls`    | string[] (1–20) | _required_ | URLs or `/docs/...` paths to fetch (same rules as `read_doc`) |

**Example Prompts:**

- _"Compare the Calculate Route and Calculate Bike Route examples"_
- _"Read all the migration guides and tell me what changed between 2.11.0 and 3.1.10"_
- _"Fetch the routing guides for Flutter, Android, and iOS and summarize the differences"_
- _"Read every weather-related page in the Flutter docs and produce one combined cheat sheet"_
- _"Pull the whole Get Started section plus the API-key guide so I can onboard a new developer"_

### 4. Documentation Browsing (`list_docs`)

Browse the documentation index. `mode: "sections"` returns a compact table of contents (sections with page counts); `mode: "pages"` lists pages with title, URL and description (a description over 200 characters is cut to its first sentence, or at a word - where the room ends when its second half has no space), grouped by source and section. When `mode` is omitted it defaults to `sections` for `source: all` without a filter, and `pages` otherwise - start with the TOC, then drill into one source or section. The `pages` listing is paged - also for a single source: 50 pages per call by default and 100 at most, with `offset`/`limit`; the response says how many pages remain and which offset continues. An `offset` beyond the listing is an error.

**Input Parameters:**

| Parameter | Type                                                                                                 | Default   | Description                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `source`  | `all` \| `developer` \| `flutter` \| `android` \| `ios` \| `cpp` \| `typescript` \| `cloud-rest-api` | `all`     | Restrict listing to one documentation source                                                         |
| `section` | string (≤64 chars)                                                                                   | _(none)_  | Case-insensitive substring filter on the section, e.g. `"routing"` or `"Examples › Maps & 3D Scene"` |
| `mode`    | `sections` \| `pages`                                                                                | _(smart)_ | `sections` = compact TOC with page counts; `pages` = page list                                       |
| `offset`  | number (≥0)                                                                                          | `0`       | `pages` mode: skip this many pages                                                                   |
| `limit`   | number (1–100)                                                                                       | `50`      | `pages` mode: pages per response                                                                     |

**Structured output:** `mode`, `total` (pages matching the filters), `message` (what is shown and how to continue), `sections[]` (`source`, `section`, `pages` - in `sections` mode), `pages[]` (`title`, `url`, `path`, `description`, `source`, `section` - in `pages` mode), `offset`, `nextOffset?` (absent at the end) and `failedSources[]`.

**Example Prompts:**

- _"What documentation exists for the Magic Lane Android SDK?"_
- _"List all Magic Lane docs pages about routing and navigation"_
- _"List the iOS SDK examples for Maps & 3D Scene"_
- _"Show every Cloud REST API guide grouped by section"_
- _"Which migration guides exist for the Flutter SDK?"_
- _"List the TypeScript SDK pages in the Places & Search section"_

### 5. Code Example Extraction (`get_code_examples`)

Extract only the code blocks from a page, skipping the prose - cheaper than reading the whole page when only the sample code matters. Each block is labelled with the heading above it and its caption ("Request Body"), so you can tell which step it belongs to. Fences may be indented (inside list items); a block indented four columns beyond its list item (an indented code block) counts too, tagged `text` as a fence that names no language is (the `language: text` filter finds both), and headings are read as CommonMark does (a setext underline heads the paragraph above it, closing `#`s are dropped). Blocks come in order up to a character budget; a longer block is split into parts, and the response says which `offset` continues.

When the page has no matching block, the response lists the languages it does have and points to nearby pages of the same source that hold code - the pages below it, related pages, or, for an example page, the guides on its topic - with how many matching blocks each has.

**Input Parameters:**

| Parameter  | Type                 | Default    | Description                                                                                                                                                                                                                                                                        |
| ---------- | -------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`      | string (1–500 chars) | _required_ | Absolute `developer.magiclane.com` URL or a `/docs/...` path                                                                                                                                                                                                                       |
| `language` | string (≤64 chars)   | _(none)_   | Only return blocks with this language tag; aliases are honoured (`ts`, `js`, `kt`, `c++`, `yml`, `sh`/`bash`/`zsh`/`console`, `objective-c`)                                                                                                                                       |
| `caption`  | string (≤64 chars)   | _(none)_   | Only return blocks whose caption contains this text (case-insensitive): `request` keeps the labelled request bodies of a REST API page, `response` the responses; blank means no filter                                                                                            |
| `offset`   | number (≥0)          | `0`        | Skip this many matching blocks (for paging; a block split into parts counts each part)                                                                                                                                                                                             |
| `maxChars` | number (1–50,000)    | `24000`    | Character budget for the returned code; a longer block is split into parts of at most the budget less about 200 characters for the header - at most 2,000 when the budget is smaller, so a budget below that still returns one such part (a block's last part is whatever is left) |

**Example Prompts:**

- _"Show me just the Dart code from the Calculate Route example"_
- _"Get the Kotlin snippets for adding markers on Android"_
- _"Extract the Swift code from the iOS center-map example"_
- _"Give me only the JSON request bodies from the Fleet Management add-optimization guide"_
- _"Pull the C++ code from the fleet-management example"_

### 6. Cross-SDK Lookup (`find_across_sdks`)

Returns the best-matching page(s) for one topic in **every** source, side by side. Platform and comparison words (_iOS_, _cloud_, _vs_, …) are ignored unless part of a feature name ("Android Auto"), a page title or the product name ("rest api"); "flutter vs android" gets each platform's overview page. A source reports `(no match)` unless a page covers half the topic in its title or description and is about its most specific word (in its title or section, or in its description or path with every other word). Short topics must match in full; when no page is headed with a word, a page whose full text names it at least twice answers, flagged `onlyInText`. Action and setup words may be missing. Passing mentions are left to `search_docs`. An unloaded index shows `(index not loaded: <reason>)`.

**Input Parameters:**

| Parameter        | Type                 | Default    | Description                                |
| ---------------- | -------------------- | ---------- | ------------------------------------------ |
| `query`          | string (1–300 chars) | _required_ | The topic to look up, e.g. `"add markers"` |
| `limitPerSource` | number (1–5)         | `1`        | How many matches to return per source      |

**Structured output:** `query`, `topic` (the query without platform words), `message`, `sources[]` - one per source, in a fixed order: `source`, `name`, `status` (`matched`, `no match` or `index not loaded` with `reason`), `matches[]` (`title`, `url`, `path`, `description`, `source`, `section`, and `onlyInText?`: the topic words a page covering part of the topic lacks in its title, section and description, which its own text names) - `unverified[]` (`word`, `source`: platform words left out of the topic that could not be checked against their platform's titles because that index did not load, so one may be part of a feature name) and `failedSources[]` (a failed `full-text` file leaves its source's pages that lack a word of the topic unchecked, and unlisted).

**Example Prompts:**

- _"How do I add markers on iOS vs Android vs Flutter?"_
- _"Find the offline maps documentation for every SDK"_
- _"Compare how turn-by-turn navigation is documented across all platforms"_
- _"Which SDKs document weather services, and where?"_
- _"Find the search/geocoding page in each SDK - give me 2 matches per source"_ (`limitPerSource: 2`)
- _"Where is public transit routing covered on each platform?"_

### 7. Recency Tracking (`list_recent_updates`)

List the documentation pages updated in the last N days, per source, from the "Last updated" date each page carries (no extra fetches). The window counts whole days in UTC: `days: 1` is yesterday and today (and a page dated tomorrow, as a time zone ahead of UTC may date it); each line gives the date, title, source and page URL, newest first. When nothing changed in the window, the response lists the newest pages instead, so a quiet fortnight is not an empty answer.

**Input Parameters:**

| Parameter | Type           | Default | Description                                                                                                                                        |
| --------- | -------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `days`    | number (1–365) | `30`    | Look-back window in calendar days (UTC), inclusive                                                                                                 |
| `source`  | source id      | `all`   | Restrict to one documentation source                                                                                                               |
| `limit`   | number (1–100) | `50`    | Maximum number of pages to report                                                                                                                  |
| `offset`  | number (≥ 0)   | `0`     | Pages of the window, newest first, to skip: the `nextOffset` of the previous answer; a positive offset at or past the window's `total` is an error |

**Structured output:** `days`, `source`, `message`, `total` (pages dated within the window), `updates[]` (`limit` of them from `offset`: `title`, `source`, `date`, `url?`, `path?`), `offset`, `nextOffset?` (the offset that lists the next pages; absent at the end), `newestDate?` (the newest date among the selected sources' pages), `newestPages[]` (only when `updates` is empty: their newest pages, all older than the window) and `failedSources[]`.

**Example Prompts:**

- _"What changed in the iOS SDK docs this month?"_
- _"Which Cloud REST API pages were updated in the last 90 days?"_
- _"Show me everything updated across all SDK docs in the last week"_ (`days: 7`)
- _"List the 10 most recently updated Android SDK pages this year"_ (`days: 365, limit: 10`)
- _"Did the iOS SDK docs change since our last release four weeks ago?"_

### 8. Product Guides (`get_product_guide`)

Return the official documentation for a Magic Lane product - use it for questions about the products themselves rather than the Maps SDKs:

- **`mcp-server`** - the geospatial MCP that gives AI agents location search, multi-modal routing, isochrone analysis, reverse geocoding, geofence management, and map rendering. Sections: `overview`, `usage-guidelines` (default).
- **`map-studio`** - Magic Lane Studio (formerly Map Studio), the web-based visual editor for creating, testing, and publishing custom map styles. Sections: `overview` (default), `create-a-map-style`, `customize-map-style`, `download-style`. The Developer site is replacing the Map Studio pages with the Magic Lane Studio guide (`getting-started/create-a-style`, `tutorials/first-style`, `getting-started/download-and-use`); each section is read from the location the documentation index lists, trying the new one first and then the old one, so the tool works before and after the switch.

The sections share a 120,000-character budget, at most 50,000 each (longer pages say where to continue with `read_doc`). Sections that fail to load are reported individually; the call is an error only when every section failed.

**Input Parameters:**

| Parameter | Type                         | Default             | Description                                                            |
| --------- | ---------------------------- | ------------------- | ---------------------------------------------------------------------- |
| `product` | `mcp-server` \| `map-studio` | _required_          | Which product guide to return                                          |
| `section` | section id \| `all`          | _(product default)_ | Which guide section; `all` concatenates every section in reading order |

**Example Prompts:**

- _"How should my agent use the Magic Lane MCP Server tools effectively?"_
- _"What is the Magic Lane MCP Server and how do I connect to it?"_
- _"What is Map Studio and what can I do with it?"_
- _"How do I create a custom map style and use it in my app?"_ (`product: map-studio, section: create-a-map-style`)
- _"Give me the complete Map Studio documentation"_ (`section: all`)

### Resources

The raw `llms.txt` indexes are also exposed as MCP **resources**:

| Resource                      | URI                                                            |
| ----------------------------- | -------------------------------------------------------------- |
| Magic Lane Guides index       | `https://developer.magiclane.com/docs/llms.txt`                |
| Maps SDK for Flutter index    | `https://developer.magiclane.com/docs/flutter/llms.txt`        |
| Maps SDK for Android index    | `https://developer.magiclane.com/docs/android/llms.txt`        |
| Maps SDK for iOS index        | `https://developer.magiclane.com/docs/ios/llms.txt`            |
| Maps SDK for C++ index        | `https://developer.magiclane.com/docs/cpp/llms.txt`            |
| Maps SDK for TypeScript index | `https://developer.magiclane.com/docs/typescript/llms.txt`     |
| Cloud REST APIs index         | `https://developer.magiclane.com/docs/cloud-rest-api/llms.txt` |

---

## Troubleshooting

### Common Issues

Client-specific checks (the tools picker, approvals, reloading the window) are in each guide's **Verify** section, and HTTP status codes (`400`, `403`, `404`, `405`, `406`, `408`, `413`, `429`, `503`, `EADDRINUSE`) in [HTTP server › Troubleshooting](https://github.com/magiclane/magiclane-mcp-docs-server/blob/HEAD/docs/http-server-setup.md#troubleshooting).

- **Server won't start** - Ensure Node.js 22+ (`node --version`) and that `npm run build` completed; the stdio entry is `dist/docs-server.esm.js`. `node src/docs-server.ts` cannot work - use `npm run dev` for the sources.
- **`## Sources not loaded` in a tool response** - one or more `llms.txt` / `llms-full.txt` files could not be loaded; results from those sources are missing. The note says whether `developer.magiclane.com` could not be reached or a file was published empty - either way not a documentation gap. When no source loads at all the call is an error.
- **Empty search results** - Try broader keywords, or browse with `list_docs` first.
- **Stale content** - Fetched pages and indexes are cached in memory for 1 hour (and served stale when a refresh fails); restart the server to force a refresh.

### Common Error Messages

| Message                                                                                       | Meaning                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Not a documentation page (HTML response) for <url>`                                          | The path is not a markdown page (the site answered with its HTML shell) - discover URLs via search or listing                                                                                                                   |
| `HTTP 404 Not Found for <url>`                                                                | The resource does not exist; remembered for 60 s                                                                                                                                                                                |
| `Only https://developer.magiclane.com documentation URLs are supported; got <host>`           | `read_doc` and friends accept `developer.magiclane.com` references only                                                                                                                                                         |
| `offset N is beyond the end of the page (M characters)`                                       | `read_doc` was called with an `offset` past the end                                                                                                                                                                             |
| `Could not load the documentation index for any of the requested documentation source(s)`     | No requested source could be loaded. The message says which: developer.magiclane.com could not be reached (it then adds "retry shortly"), or it answered without a usable file (not found, HTML, empty) - a retry will not help |
| `The documentation host is busy (64 page fetches already waiting); retry in a few seconds.`   | HTTP transport under load: the outbound queue is full                                                                                                                                                                           |
| `Too many uncached documentation pages requested by this client (120 per 60 s); retry in N s` | HTTP transport: one client's budget of new page fetches is spent; pages already read stay available                                                                                                                             |

---

## Privacy Policy

**Data Collection:** This server collects nothing. There is no telemetry, no analytics, and no logging of queries beyond the local process's stderr.

**How Data Is Used:** Tool inputs are used solely to fetch and rank publicly available documentation from `developer.magiclane.com`.

**Data Storage & Retention:** Fetched pages and indexes are held in memory only and discarded when the process exits; an entry is refreshed after an hour (and served as it was when a refresh fails). Nothing is written to disk.

**Third-Party Data:** The only outbound requests are to `developer.magiclane.com`. No data is shared with any other party.

---

## Support

- **Documentation**: [developer.magiclane.com/docs](https://developer.magiclane.com/docs)
- **API Dashboard**: [developer.magiclane.com/api/dashboard](https://developer.magiclane.com/api/dashboard)
- **GitHub Issues**: [github.com/magiclane/magiclane-mcp-docs-server/issues](https://github.com/magiclane/magiclane-mcp-docs-server/issues)
- **Developer Portal Support**: Contact support through the developer portal
