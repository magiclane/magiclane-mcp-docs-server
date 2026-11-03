/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { STDIO } from './config/constants.js';
import { createServer } from './server.js';
import { callsInFlight, callsSettledOrStalled } from './utils/calls-in-flight.js';
import { protocolErrorLine } from './utils/errors.js';
import { stopSendingOnHang, upstreamIdleSince } from './utils/http-client.js';
import { invalidRequestError, JsonRpcLineGuard } from './utils/jsonrpc-lines.js';
import { logVerbose } from './utils/logger.js';

async function main(): Promise<void> {
  const server = createServer();
  // Each line the client sends is checked before the transport reads it: a
  // line that is not JSON-RPC, or a message the protocol rejects, is said on
  // stderr (stdout is the protocol's) in one line naming the message's method
  // and id and what was wrong, instead of vanishing (see protocolErrorLine:
  // the client's text cannot break that line, nor make it long) — and a
  // request with an id gets the Invalid Request error it is owed.
  const guard = new JsonRpcLineGuard((bad) => {
    console.error(protocolErrorLine(bad.error, bad.message));
    const answer = invalidRequestError(bad);
    if (answer) void transport.send(answer);
  });
  const transport = new StdioServerTransport(guard, process.stdout);
  /** Set once the client has closed stdin: the transport closing then is the expected end. */
  let clientLeft = false;
  /** Set when calls still running then were given up: the exit status says so. */
  let gaveUp = false;
  // What the protocol itself reports (a response to a request nobody sent, a
  // line over the transport's buffer), one line each.
  server.server.onerror = (err) => console.error(protocolErrorLine(err));
  // Closing the server aborts the calls still running (their fetches follow);
  // a transport that closes on its own (a line over its buffer) leaves the
  // server deaf, so the process ends, with status 1, instead of idling. The
  // process exits once stdout has taken what was written to it (a pipe keeps
  // a late result until then), not before: with status 0 when every call the
  // client sent was answered, 1 when some were given up.
  server.server.onclose = () => {
    if (!clientLeft) console.error('The stdio transport closed: exiting.');
    exitOnceFlushed(clientLeft && !gaveUp ? 0 : 1);
  };
  // The client closing stdin asks for a clean end: the calls it is still
  // waiting for (tool calls, resource reads) finish and their results go out
  // first — then the server closes. A one-shot pipe (requests, then EOF)
  // reads them; a client that is gone (killed, say) closed stdin too, and its
  // calls on a hanging site must not keep the process alive and fetching for
  // the calls' own limits (up to FETCH.batchTimeoutMs). So each request the
  // site was sent is waited for on its own limits (a first byte may take up
  // to FETCH.timeoutMs), but the first one the site leaves unanswered that
  // long stops the sending: the calls answer with what they have (to a
  // killed client, the first write ends the process). STDIO.closeGraceMs with
  // nothing left to wait for from the site ends the wait: closing the server
  // gives up the calls still running.
  guard.on('end', () => {
    clientLeft = true;
    const running = callsInFlight();
    if (running > 0) console.error(`stdin closed: finishing ${running} running call(s) first.`);
    stopSendingOnHang();
    void callsSettledOrStalled(STDIO.closeGraceMs, upstreamIdleSince).then((outcome) => {
      if (outcome === 'stalled') {
        gaveUp = true;
        console.error(
          `Nothing to wait for from the site for ${STDIO.closeGraceMs / 1000} s since stdin closed (no request within its own limits, no byte): giving up the ${callsInFlight()} running call(s).`
        );
      }
      return server.close();
    });
  });
  // The client went away without closing stdin first (the pipe broke): no
  // result can reach it, so stop instead of failing every later write.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`stdout closed (${err.code ?? err.message}): exiting.`);
    process.exit(1);
  });
  // stdin failing to be read is the end of the input too.
  process.stdin.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`stdin failed (${err.code ?? err.message}): finishing.`);
    guard.end();
  });
  process.stdin.pipe(guard);
  await server.connect(transport);
  // stdout is reserved for the MCP protocol; log to stderr only.
  console.error('Magic Lane MCP Docs Server running on stdio');
  logVerbose('verbose logging enabled — tool invocations will be logged to stderr');
}

/** Exits with `code` once what was written to stdout has left the process: a result is not cut off. */
function exitOnceFlushed(code: number): void {
  process.exitCode = code;
  process.stdout.write('', () => process.exit(code));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
