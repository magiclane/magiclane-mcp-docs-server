# Changelog

All notable changes to the **Magic Lane MCP Docs Server** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-03

First release. Gives AI agents live, searchable access to the Magic Lane
developer documentation at developer.magiclane.com: the developer guides, the
Maps SDKs for Flutter, Android, iOS, C++ and TypeScript, and the Cloud REST
APIs. Nothing is bundled and no API key is required.

### Added

- **Tools** (all read-only): `search_docs`, `read_doc`, `read_docs_batch`,
  `list_docs`, `get_code_examples`, `find_across_sdks`, `list_recent_updates`
  and `get_product_guide`.
- **Resources**: the `llms.txt` index of each documentation source.
- **Transports**: stdio (`magiclane-mcp-docs`, the command to configure,
  and `mcp-docs-server`, the one `npx -y @magiclane/mcp-docs-server` runs)
  and stateless Streamable HTTP (`magiclane-mcp-docs-http`) with `/health`
  and `/ready` endpoints, configured through environment variables.
- **Search**: word-based ranking that understands platform names
  ("get started flutter"), common word forms and feature names such as
  "Android Auto", with full-text excerpts.
- **Reliability**: a shared, cached HTTP client with timeouts, fair limits
  per client and stale copies served during outages.
- **Packaging**: npm package `@magiclane/mcp-docs-server` (Node.js 22 or
  newer), MCP Bundle and Docker image.
- **Docs**: setup guides for VS Code, Visual Studio, Android Studio, Cursor,
  Claude Desktop and the HTTP server, and how to connect to the hosted server
  at `https://developer.magiclane.com/docs-mcp`.

### Security

- Fetches only over HTTPS from `developer.magiclane.com`.
- The HTTP transport validates `Host` and `Origin`, rate-limits clients and
  caps request bodies; CORS is off by default.
