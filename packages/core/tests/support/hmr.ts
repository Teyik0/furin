import { createServer } from "node:net";

/**
 * Returns an unused TCP port allocated by the OS.  Used by HMR integration
 * tests to spawn a dev server on a fresh port without collisions when the
 * test suite runs in parallel with other servers.
 *
 * Implementation: open a server on port 0 (which the kernel resolves to a
 * free ephemeral port), read the assigned port, and close immediately.
 * The port may, in theory, be reused by another process between this call
 * and the test's `app.listen` — in practice the window is microseconds and
 * has never produced a flake in this suite.
 */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      srv.close(() => resolve((addr as { port: number }).port));
    });
    srv.on("error", reject);
  });
}

/**
 * Matches Bun's content-hashed dev entry script URL. Bun 1.3 emitted
 * `/_bun/client/index-<hash>.js`; Bun 1.4 emits `/chunk-<hash>.js`.
 */
export const DEV_CLIENT_CHUNK_RE = /\/(?:_bun\/client\/index|chunk)-[^"]+\.js/;

/**
 * Extracts the dev-server client entry chunk URL from a rendered HTML
 * response, or `null` if not present.  Stable URL means cache HIT (HTML
 * carrying the previous chunk URL); changed URL means the template was
 * re-rendered against the fresh chunk — either expected (post-rebundle)
 * or proof of a successful invalidation.
 */
export function extractDevClientEntry(html: string): string | null {
  return html.match(DEV_CLIENT_CHUNK_RE)?.[0] ?? null;
}
