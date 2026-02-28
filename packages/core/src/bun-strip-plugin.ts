/**
 * Lazily fetches the Bun-processed /_bun_hmr_entry HTML and caches it.
 *
 * The fetched HTML is used as the SSR template: it contains the
 * content-hashed chunk paths and HMR WebSocket client that Bun injected,
 * plus our <!--ssr-head--> and <!--ssr-outlet--> placeholders which Bun
 * preserves as-is.
 *
 * Must be called from within a request handler (after the server is listening
 * and serve.routes["/_bun_hmr_entry"] is registered).
 *
 * @param origin - The server origin, e.g. "http://localhost:3000".
 *                 Derived from ctx.request.url in request handlers.
 */
let _devTemplatePromise: Promise<string> | null = null;

export function getDevTemplate(origin: string): Promise<string> {
  _devTemplatePromise ??= fetch(`${origin}/_bun_hmr_entry`)
    .then((r) => {
      if (!r.ok) {
        throw new Error(`/_bun_hmr_entry returned ${r.status}`);
      }
      return r.text();
    })
    .catch((err) => {
      _devTemplatePromise = null;
      throw err;
    });
  return _devTemplatePromise;
}

export function resetDevTemplate(): void {
  _devTemplatePromise = null;
}
