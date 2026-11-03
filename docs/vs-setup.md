<!--
SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
SPDX-License-Identifier: Apache-2.0
-->

# Visual Studio Setup

Connect the **Magic Lane MCP Docs Server** to Visual Studio so GitHub Copilot's
agent mode can search and read the Magic Lane developer documentation (the Maps
SDKs for Flutter, Android, iOS, C++, TypeScript, and the Cloud REST APIs) while
you code.

The whole setup takes about ten minutes. Follow the steps in order; each one
ends with a way to confirm it worked before you move on.

## Prerequisites

- **Visual Studio 2026**, or **Visual Studio 2022 version 17.14** or later —
  agent mode with MCP tool support is generally available from 17.14. Use the
  latest servicing release for the newest MCP features.
- An active **GitHub Copilot** subscription, signed in inside Visual Studio.
- **Node.js 22+** on `PATH` (`node --version`).
- No API key or account is required — the documentation this server exposes is public.

Build the server from a clone of the repository:

```bash
git clone https://github.com/magiclane/magiclane-mcp-docs-server.git
cd magiclane-mcp-docs-server
npm install
npm run build        # produces dist/docs-server.esm.js (stdio) and dist/docs-server-http.esm.js (HTTP)

# note your absolute path to node, you will need it for the MCP config
# Mac/Linux
which node
# Example output: /usr/local/bin/node

# Windows
where node
# Example output: C:\Program Files\nodejs\node.exe
```

Or, once the package is published, install it globally — this provides the
`magiclane-mcp-docs` (stdio) and `magiclane-mcp-docs-http` (HTTP) commands:

```bash
npm install -g @magiclane/mcp-docs-server
```

Or run it as a container (HTTP transport):

```bash
npm run docker:build   # docker build, with the version, revision and build-time labels filled in
docker run --rm -p 127.0.0.1:3000:3000 magiclane-mcp-docs-server
```

### Check your Visual Studio and Copilot

1. Open Visual Studio and go to **Help → About Microsoft Visual Studio**. The
   version must be **17.14 or later** (or any Visual Studio 2026 build). If it is
   older, run the **Visual Studio Installer** and click **Update**.
2. Look at the **GitHub Copilot** badge in the top-right of the main window. It
   should show your GitHub account. If it says _Sign in_ or the badge is missing,
   click it and complete the sign-in, then confirm your subscription is active
   at [GitHub Copilot](https://github.com/settings/copilot).
3. Open **View → GitHub Copilot Chat**. If the mode selector at the bottom of the
   chat window offers **Agent**, you are ready. If it only offers _Ask_, update
   Visual Studio — agent mode and MCP arrive together in 17.14.

## MCP Client Setup

### Choose a scope

Visual Studio discovers MCP servers from an `.mcp.json` file, checking these
locations in order (the first match wins):

| Path                             | Scope                                              |
| -------------------------------- | -------------------------------------------------- |
| `%USERPROFILE%\.mcp.json`        | Global — loads for every solution (recommended)    |
| `<SolutionDir>\.vs\mcp.json`     | This solution, this user only (not source-tracked) |
| `<SolutionDir>\.mcp.json`        | This solution — can be committed to source control |
| `<SolutionDir>\.vscode\mcp.json` | Shared with a VS Code workspace                    |
| `<SolutionDir>\.cursor\mcp.json` | Shared with a Cursor workspace                     |

Use `%USERPROFILE%\.mcp.json` to make the server available in every solution, or
`<SolutionDir>\.mcp.json` to check it in for your team.

### Create the file

**Global (recommended).** Press `Win+R`, paste the line below and press Enter.
Notepad opens the file, creating it if it does not exist yet:

```
notepad "%USERPROFILE%\.mcp.json"
```

**Solution-level.** In **Solution Explorer**, right-click the solution → **Add →
New Item**, choose **JSON File**, name it exactly `.mcp.json` and make sure it is
created in the solution directory (next to the `.sln` file), not inside a
project.

Visual Studio reads the `servers` schema (the same as VS Code): each entry has
a `type` and, for stdio, a `command` with `args`.

### Node version

This method runs the built bundle directly with Node.js. Build first
(`npm run build`); pointing `args` at `src/docs-server.ts` does **not** work
(`ERR_MODULE_NOT_FOUND`), because the sources are TypeScript.

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

Once the package is installed globally, the `magiclane-mcp-docs` command can
replace `node` plus the path:

```json
{
  "servers": {
    "magiclane-docs": {
      "type": "stdio",
      "command": "magiclane-mcp-docs"
    }
  }
}
```

### HTTP Version (shared or containerized server)

The server also speaks Streamable HTTP, which is useful when one instance serves
several editors or runs in Docker. Start it with `npm run start:http` (or the
Docker container above), then:

```json
{
  "servers": {
    "magiclane-docs": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

See [`http-server-setup.md`](./http-server-setup.md) for the environment
variables that govern the port, path, CORS policy, Host allowlist and trusted
proxies.

## Enable the server in Copilot

1. Visual Studio watches the config locations and picks up the new file
   automatically — no restart needed. If you had a solution open, you may see a
   notification that a new MCP server was found; click it to review.
2. Open **View → GitHub Copilot Chat**.
3. In the mode selector at the bottom of the chat window, switch from **Ask** to
   **Agent**.
4. Click the **tools** icon (the wrench, next to the mode selector). The tool
   picker lists every MCP server. Find **magiclane-docs** and make sure it and
   its tools are checked.

The first time a server is enabled, Visual Studio may ask you to trust it.
Confirm — the server only reads public documentation and makes no changes on
your machine.

## Verify

1. With the picker still open, confirm eight `magiclane-docs` tools are listed:
   `search_docs`, `read_doc`,
   `read_docs_batch`, `list_docs`,
   `get_code_examples`, `find_across_sdks`,
   `list_recent_updates`, `get_product_guide`.
2. Ask: _"Search the Magic Lane docs for how to calculate a route in Flutter."_
   Approve the tool call when Copilot prompts — the tools are read-only, so a
   single approval sticks. Choose **Allow for this solution** (or _Always_) to
   avoid re-approving each turn.
3. Copilot should reply with page titles and `developer.magiclane.com` URLs,
   then read the relevant page.
