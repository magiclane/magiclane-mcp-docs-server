# SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
# SPDX-License-Identifier: Apache-2.0
#
# Magic Lane MCP Docs Server — Streamable HTTP image.
#
#   npm run docker:build          # docker build with the OCI labels filled in
#   docker run --rm -p 127.0.0.1:3000:3000 magiclane-mcp-docs-server
#
# Three stages keep the runtime image small and free of build tooling: `build`
# compiles the bundles, `deps` installs production dependencies only, and
# `runtime` copies just those two results. The server runs as the unprivileged
# `node` user and listens on every interface inside the container (MCP_HTTP_HOST
# below) — publish the port to localhost only unless a reverse proxy fronts it.
#
# The base image is a build argument: `npm run docker:build` pins it by digest
# (node:22-slim@sha256:…, resolved when it runs), so a build is reproducible
# and records exactly what it was built on (the base.name label) — unless no
# digest can be resolved (offline, Docker Hub rate-limiting), when it warns
# and builds on the tag; a plain `docker build` uses the node:22-slim tag as
# it is that day.
ARG NODE_IMAGE=node:22-slim

# --- build: compile TypeScript into dist/ -------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json rollup.config.js ./
COPY src ./src
# rollup directly: `npm run build` would first run the clean script, which the
# context does not carry (and a fresh stage has nothing to clean).
RUN npx rollup -c

# --- deps: production node_modules only ---------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# --- runtime -------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
# The server runs node alone: the package managers the base image carries
# (npm, npx, corepack, yarn — whose bundled packages have known advisories that
# image scanners report) and Node's C headers are removed.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/include/node \
      /opt/yarn-v* /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg
ENV NODE_ENV=production
# Inside a container the server must bind beyond loopback to be reachable.
# The port is NOT fixed here: MCP_HTTP_PORT or PORT (as set by Cloud Run and
# similar platforms) picks it; the default is 3000.
ENV MCP_HTTP_HOST=0.0.0.0
WORKDIR /app
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY package.json LICENSE README.md REUSE.toml ./
COPY LICENSES ./LICENSES
USER node
EXPOSE 3000
# The probe picks the port with the same rule as src/config/env.ts: a non-blank
# MCP_HTTP_PORT is used if valid, else 3000 (PORT is not consulted then); a
# blank or unset MCP_HTTP_PORT defers to PORT, which falls back to 3000 too.
# test/dockerfile.test.ts runs this script against readEnv to keep them equal.
# It probes /health, the liveness endpoint: 200 while serving ("ok",
# "degraded", "saturated", "starting" or "unavailable" — also when busy or when
# developer.magiclane.com is unreachable, so neither gets a container
# restarted) and 503 only while shutting down. Point a load balancer at /ready
# instead, which is 503 while the queue is full, until the first index has
# loaded, and while no index is loaded and loading one fails.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "const e=process.env;const v=e.MCP_HTTP_PORT===undefined||e.MCP_HTTP_PORT.trim()===''?e.PORT:e.MCP_HTTP_PORT;const n=Number((v??'').trim());const port=v&&Number.isInteger(n)&&n>=1&&n<=65535?n:3000;fetch('http://127.0.0.1:'+port+'/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/docs-server-http.esm.js"]
# OCI image metadata, last: the labels change with every build (the
# revision and the build time), so they come after the layers that do not,
# which stay cached. The version, revision and build time are build
# arguments: `npm run docker:build` (scripts/docker-build.mjs) passes them
# from package.json, git and the clock; a plain `docker build` leaves the
# version and revision "unknown" and the build time at the Unix epoch (the
# label must be an RFC 3339 date) unless each is passed: --build-arg
# VERSION=1.0.0 --build-arg REVISION=$(git rev-parse HEAD) --build-arg
# CREATED=$(date -u +%FT%TZ).
ARG NODE_IMAGE
ARG VERSION=unknown
ARG REVISION=unknown
ARG CREATED=1970-01-01T00:00:00Z
LABEL org.opencontainers.image.title="Magic Lane MCP Docs Server" \
      org.opencontainers.image.description="MCP server for the Magic Lane developer documentation (HTTP transport)" \
      org.opencontainers.image.vendor="Magic Lane International B.V." \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/magiclane/magiclane-mcp-docs-server" \
      org.opencontainers.image.documentation="https://github.com/magiclane/magiclane-mcp-docs-server#readme" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.base.name="${NODE_IMAGE}"
