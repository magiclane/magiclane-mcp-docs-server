# Claude Desktop Setup Guide

Connect the **Magic Lane MCP Docs Server** to Claude Desktop so Claude can
search and read the Magic Lane developer documentation (Maps SDKs for Flutter,
Android, iOS, C++, TypeScript, and the Cloud REST APIs) while it answers.

## Prerequisites

- [Claude Desktop](https://claude.ai/download) installed (Windows, macOS or Linux)
- Node.js 22+ (`node --version`) — not needed to run the `.mcpb` bundle (Option D),
  which runs on the Node.js built into Claude Desktop, only to build one
- No API key or account is required — the documentation this server exposes is public

## Getting the Server

Four ways, lettered A to D here and again under **2. Configure the Server**.
Options A to C need an entry in Claude Desktop's configuration file (steps 1
to 3); Option D, the MCP Bundle, is installed from Claude Desktop's settings
and needs no file.

### Option A: The npm package

Once the package is published, there is nothing to build: `npx` downloads and
runs it when Claude Desktop starts the server (configuration Option A below).
To install it once instead:

```bash
npm install -g @magiclane/mcp-docs-server   # provides the magiclane-mcp-docs command
```

Until then, use one of the options below.

### Option B: A local build

From the repository root, build the server:

```bash
git clone https://github.com/magiclane/magiclane-mcp-docs-server.git
cd magiclane-mcp-docs-server
npm install
npm run build
```

The stdio entry point is produced at `dist/docs-server.esm.js` (configuration
Option B below). Running the TypeScript sources directly with
`node src/docs-server.ts` does not work; use the built bundle.

Claude Desktop does not always see the `PATH` of your shell, so note the
absolute path of Node.js too:

```bash
which node    # macOS / Linux
where node    # Windows
```

### Option C: Docker

Build the image:

```bash
npm run docker:build   # docker build, with the version, revision and build-time labels filled in
```

The image starts the HTTP server by default; Claude Desktop runs the stdio
server from the same image instead (configuration Option C below).

### Option D: The MCP Bundle (`.mcpb`)

An MCP Bundle is one file that Claude Desktop installs as an extension: the
built server, its production dependencies and `manifest.json`, which tells
Claude Desktop how to start it (`node dist/docs-server.esm.js`, on the Node.js
built into Claude Desktop) and declares its one setting, **Verbose logging**.

Once published, the GitHub release of each version carries the bundle as an
attachment. Until then, build it in a clone (this needs Node.js 22+), with the
production dependencies only, as the release does:

```bash
git clone https://github.com/magiclane/magiclane-mcp-docs-server.git
cd magiclane-mcp-docs-server
npm ci
npm run build
npm ci --omit=dev      # the bundle carries node_modules: production dependencies only
npx -y @anthropic-ai/mcpb@2.1.2 pack . magiclane-mcp-docs-server.mcpb
npm ci                 # the development dependencies back, to go on working in the clone
```

The bundle is `magiclane-mcp-docs-server.mcpb` in the root of the clone.
`npm run release` builds it too, as `magiclane-mcp-docs-server-<version>.mcpb`,
but that is the maintainer's release-day script: it needs a clean clone,
REUSE 6.2.0 at hand and a `CHANGELOG.md` entry for the version dated that day,
and stops otherwise.

To install it, open Claude Desktop and go to **Settings → Extensions**: under
**Advanced settings**, **Install Extension…** opens the `.mcpb` file (opening
the file with Claude Desktop from your file manager does the same). Claude
Desktop shows what the bundle contains and asks you to confirm; it then starts
the server itself, and the extension's card holds the **Verbose logging**
switch. No configuration file is edited: go on to step 4.

## 1. Open the Configuration File

Options A to C: Claude Desktop reads its local MCP servers from
`claude_desktop_config.json`:

| System  | Location                                                          |
| ------- | ----------------------------------------------------------------- |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json`                     |
| macOS   | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux   | `~/.config/Claude/claude_desktop_config.json`                     |

The quickest way to open it: **Settings → Developer → Edit Config**. Claude
Desktop creates the file if it does not exist yet.

## 2. Configure the Server

Add a `magiclane-docs` entry under `mcpServers` (keep any servers already
there), for the option you chose above; the bundle (Option D) needs no entry.

### Option A: npm package with `npx`

```json
{
  "mcpServers": {
    "magiclane-docs": {
      "command": "npx",
      "args": ["-y", "@magiclane/mcp-docs-server"]
    }
  }
}
```

With the package installed globally, `"command": "magiclane-mcp-docs"` with no
`args` works too.

### Option B: Local build

```json
{
  "mcpServers": {
    "magiclane-docs": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/magiclane-mcp-docs-server/dist/docs-server.esm.js"]
    }
  }
}
```

### Option C: Docker

```json
{
  "mcpServers": {
    "magiclane-docs": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "magiclane-mcp-docs-server", "node", "dist/docs-server.esm.js"]
    }
  }
}
```

`-i` keeps stdin open: Claude Desktop talks to the server over the container's
stdin and stdout, and the container is removed when Claude Desktop stops it.

## 3. Save and Restart

1. **Check the paths** (Option B): absolute, to your `node` and to the built
   `docs-server.esm.js`. On Windows, write them with double backslashes
   (`C:\\Program Files\\nodejs\\node.exe`) or forward slashes.
2. **Check the JSON**: a trailing comma or a missing brace makes Claude Desktop
   ignore the whole file.
3. **Save** the file.
4. **Restart Claude Desktop** completely — quit it from the system tray (Windows)
   or the menu bar (macOS), not just the window — so it starts the server.

## 4. Test the Integration

1. Open a new conversation.
2. Click the **search and tools** button below the message box: **magiclane-docs**
   (the bundle: **Magic Lane MCP Docs Server**) should be listed with its eight
   tools (`search_docs`, `read_doc`, `read_docs_batch`, `list_docs`,
   `get_code_examples`, `find_across_sdks`, `list_recent_updates`,
   `get_product_guide`).
3. Ask a documentation question:
   ```
   Using the Magic Lane docs, how do I calculate a route in the Flutter SDK?
   ```
4. Claude should call `search_docs`, then `read_doc` on a
   `developer.magiclane.com` page, and answer from it. Allow the tool calls
   when asked — they are read-only.

## Expected Capabilities

Once connected, Claude can:

- **Search** the documentation of every Magic Lane SDK and the Cloud REST APIs (`search_docs`)
- **Read** whole pages, one at a time or up to 20 at once (`read_doc`, `read_docs_batch`)
- **Browse** the table of contents of each documentation source (`list_docs`)
- **Extract** just the code samples of a page, by language (`get_code_examples`)
- **Compare** how one feature is done across the SDKs (`find_across_sdks`)
- **List** the pages updated recently (`list_recent_updates`)
- **Open** the guides of Magic Lane products such as the Magic Lane MCP Server (`get_product_guide`)

When developer.magiclane.com cannot be reached, the tools say so, and name the
sources that could not be loaded, rather than answering as if the
documentation had nothing on the topic.

## Troubleshooting

- **The server is not in the tools list.** Open **Settings → Developer**: the
  entry shows its status, and **Open Logs Folder** holds
  `mcp-server-magiclane-docs.log` with the server's error output. The usual
  causes are invalid JSON, a relative path, or `node` or `npx` not found
  (use the absolute path from `which node` / `where node`).
- **The bundle is not in the tools list.** Open **Settings → Extensions**: its
  card shows whether the extension is enabled and whether it started; its log
  is in the same logs folder.
- **`npx` fails on Windows.** Use `"command": "cmd"` with
  `"args": ["/c", "npx", "-y", "@magiclane/mcp-docs-server"]`.
- **Claude answers from general knowledge.** Ask it to use the Magic Lane docs
  tools, and check that **magiclane-docs** is enabled in the tools menu.

For more detail in the log, add `"env": { "VERBOSE": "true" }` to the entry
(for the bundle, switch **Verbose logging** on in its settings): every tool
call is then logged.
