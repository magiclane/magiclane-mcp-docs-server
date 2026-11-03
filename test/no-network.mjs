/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Preloaded (`node --import`) into the built bundles the tests spawn: as in
 * test/setup.ts, no fetch of theirs may reach the network — the HTTP entry
 * starts loading the indexes as soon as it listens. TEST_FETCH_DELAY_MS makes
 * every fetch take that long before it fails, for a call that must outlive
 * its client. TEST_FETCH_INDEX_PAGES serves an llms.txt index of that many
 * pages, with long titles and descriptions (after the delay, when there is
 * one), for a call whose answer is larger than a pipe holds.
 */
const delayMs = Number(process.env.TEST_FETCH_DELAY_MS ?? 0);
const indexPages = Number(process.env.TEST_FETCH_INDEX_PAGES ?? 0);
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  // A slow site, when asked for: a call that is still running when the client leaves.
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (indexPages > 0 && url.endsWith('/llms.txt')) {
    const root = url.slice(0, -'llms.txt'.length);
    const entries = Array.from(
      { length: indexPages },
      (_, i) =>
        `- [${`Served page ${i} `.repeat(70).trim()}](${root}served-${i}.md): ${'A long description. '.repeat(20).trim()}`
    );
    return new Response(`# Served index\n\n## Docs\n\n${entries.join('\n')}\n`, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  throw new Error(`A spawned server must not reach the network (attempted fetch of ${url}).`);
};
