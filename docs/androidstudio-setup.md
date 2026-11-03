<!--
SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
SPDX-License-Identifier: Apache-2.0
-->

# Android Studio Setup (GitHub Copilot)

Connect the **Magic Lane MCP Docs Server** to Android Studio so GitHub Copilot's
agent mode can search and read the Magic Lane developer documentation while you
build your app. This is especially handy for the **Android** and **Flutter** SDK
docs, but the server covers iOS, C++, TypeScript, and the Cloud REST APIs too.

Android Studio is built on IntelliJ (JetBrains), and MCP support arrives through
the **GitHub Copilot plugin** — Copilot's agent mode and MCP support for
JetBrains IDEs became generally available in August 2025. Android Studio's
built-in Gemini assistant is separate and does not read this server; use the
Copilot plugin.

The whole setup takes about ten minutes. Follow the steps in order; each one
ends with a way to confirm it worked before you move on.

## Prerequisites

- **Android Studio** with the **GitHub Copilot** plugin installed and signed in
  (Settings → Plugins → search "GitHub Copilot"). Keep the plugin updated —
  agent mode and MCP need a recent version.
- An active **GitHub Copilot** subscription.
- **Node.js 22+** on `PATH`
- No API key or account is required — the documentation this server exposes is public.

## Build the server

From a clone of the repository:

```bash
git clone https://github.com/magiclane/magiclane-mcp-docs-server.git
cd magiclane-mcp-docs-server
npm install
npm run build        # produces dist/docs-server.esm.js (stdio) and dist/docs-server-http.esm.js (HTTP)
```

Or, once the package is published, install it globally — this provides the
`magiclane-mcp-docs` (stdio) and `magiclane-mcp-docs-http` (HTTP) commands:

```bash
npm install -g @magiclane/mcp-docs-server
```

Note the absolute path to the built bundle (or to the installed command): the
plugin spawns the server itself and needs a full path. Pointing it at
`src/docs-server.ts` does **not** work (`ERR_MODULE_NOT_FOUND`) — the sources
are TypeScript and must be built first.

## Configure the server in the Copilot plugin

The JetBrains Copilot plugin manages its MCP config through the IDE rather than a
fixed file you edit by hand:

1. Click the **GitHub Copilot** icon in the status bar (bottom of the window).
2. Choose **Edit Settings** → **Model Context Protocol** → **Configure**. The
   plugin opens its `mcp.json` in the editor (it lives in the plugin's own
   config folder, not in your project, so it applies to every project you open).
3. Paste the server definition. Copilot uses the `servers` schema (the same as
   VS Code and Visual Studio — note it is `servers`, not `mcpServers`):

```json
{
  "servers": {
    "magiclane-docs": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/magiclane-mcp-docs-server/dist/docs-server.esm.js"]
    }
  }
}
```

With the package installed globally, `"command": "magiclane-mcp-docs"` with no
`args` works too. A shared or containerized instance over Streamable HTTP
(`npm run start:http`, or the Docker image — see
[`http-server-setup.md`](./http-server-setup.md)) is configured as
`{ "type": "http", "url": "http://127.0.0.1:3000/mcp" }` instead.

4. Save (`Ctrl+S` / `Cmd+S`). Changes take effect immediately — no IDE restart.

Two things to get right in this file: it must be valid JSON (no trailing comma
after the last entry — a single stray comma silently disables every server), and
`env` values, if you add any, must be strings (`"VERBOSE": "true"`, not `true`).

## Enable the tools in Copilot Chat

1. Open **Copilot Chat** from the right-hand tool window bar.
2. Switch the mode selector at the bottom from **Ask** to **Agent**.
3. Click the **tools** icon next to the mode selector. The picker lists every
   configured MCP server; find **magiclane-docs** and make sure it and its tools
   are checked.

If the plugin asks you to trust the new server, confirm — it only reads public
documentation and makes no changes on your machine.

## Verify

1. With the picker still open, confirm the eight `magiclane-docs` tools are
   available:
   `search_docs`, `read_doc`, `read_docs_batch`, `list_docs`,
   `get_code_examples`, `find_across_sdks`,
   `list_recent_updates`, `get_product_guide`.
2. Ask: _"Show me just the Kotlin code for adding markers on the Magic Lane
   Android SDK."_ Approve the tool call when prompted — the tools are read-only,
   so a single approval sticks. Choose **Always allow** to avoid re-approving
   each turn.
3. Copilot should call `search_docs`, then `get_code_examples` with
   `language: kotlin`, and reply with fenced Kotlin blocks and the
   `developer.magiclane.com` page they came from. If it instead answers from
   general knowledge or from another map provider's site, see
   [Troubleshooting](#troubleshooting).

Working on a **Flutter** project in Android Studio? Try: _"Using the Magic Lane
Flutter SDK, how do I calculate a route between two coordinates and draw it on
the map?"_ — the same server covers the Flutter docs, and `find_across_sdks`
will show the Android and iOS equivalents side by side if you ask for a
comparison.

## Troubleshooting

- **Copilot answers from general knowledge, or quotes another map provider.**
  Check that the chat is in **Agent** mode (the tools are only offered there)
  and that **magiclane-docs** and its eight tools are checked in the tools
  picker. Then ask again, naming the tools: _"Use the Magic Lane docs tools to
  …"_.
- **The tools are missing from the picker.** The server did not start: check
  that `mcp.json` is valid JSON, that the path in `args` is absolute and points
  at the built `dist/docs-server.esm.js`, and that `node` (22 or later) is on
  the `PATH` Android Studio sees — then save `mcp.json` again so the plugin
  reloads it.
