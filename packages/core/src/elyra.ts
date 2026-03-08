import { resolve } from "node:path";
import { staticPlugin } from "@elysiajs/static";
import { Elysia } from "elysia";
import { buildClient, writeDevFiles } from "./build";
import { warmSSGCache } from "./render/index";
import { createRoutePlugin, scanPages } from "./router";

export interface ElysionProps {
  pagesDir?: string;
}

export let IS_DEV = process.env.NODE_ENV !== "production";
/** @internal test-only — overrides IS_DEV via live binding */
export function __setDevMode(val: boolean): void {
  IS_DEV = val;
}

/**
 * Main Elyra plugin.
 *
 * Returns a standalone Elysia instance (async function) so that routes are
 * properly registered in Elysia's router for SPA navigation to work.
 *
 * ## Usage
 *
 * ```ts
 * new Elysia()
 *   .use(await elyra({ ... }))
 *   .listen(3000)
 * ```
 *
 * ## Dev mode (Bun native HMR)
 *
 * The user's server.ts must statically import `.elyra/index.html` and
 * register it in serve.routes — this is what triggers Bun's HTML bundler,
 * module graph, HMR WebSocket, and React Fast Refresh.
 *
 * ## Production mode
 *
 * `elyra()` runs `Bun.build()` to produce `.elyra/client/index.html`
 * (the SSR template) plus hashed JS/CSS chunks.  No static import needed.
 * Routes with `staticParams` are pre-rendered on server start via `onStart`.
 */
export async function elyra({ pagesDir }: ElysionProps) {
  const cwd = process.cwd();
  const resolvedPagesDir = resolve(cwd, pagesDir ?? "src/pages");

  const { root, routes } = await scanPages(resolvedPagesDir);

  if (!root) {
    throw new Error(
      "[elyra] No root.tsx found. Create a root.tsx in your pages directory with a layout component."
    );
  }

  console.info(
    `[elyra] Configuration: ${routes.length} page(s) — ${IS_DEV ? "dev (Bun HMR)" : "production"}`
  );
  for (const route of routes) {
    const hasLayout = route.routeChain.some((r) => r.layout);
    console.info(
      `  ${route.mode.toUpperCase().padEnd(4)} ${route.pattern}${hasLayout ? " + layout" : ""}`
    );
  }

  // ── Dev: Bun native HMR ────────────────────────────────────────────────
  if (IS_DEV) {
    const elysionDir = resolve(cwd, ".elyra");

    // Regenerate .elyra/_hydrate.tsx with the current page list.
    // Only writes when content changed so Bun --hot doesn't reload needlessly.
    writeDevFiles(routes, { outDir: elysionDir, rootPath: root.path });

    let instance = new Elysia()
      .use(
        await staticPlugin({
          assets: resolve(cwd, ".elyra"),
          prefix: "/_bun_hmr_entry",
        })
      )
      .use(await staticPlugin());

    for (const route of routes) {
      instance = instance.use(createRoutePlugin(route, root));
    }

    return instance;
  }

  // ── Production ──────────────────────────────────────────────────────────
  const elysionDir = resolve(cwd, ".elyra");
  await buildClient(routes, { dev: false, outDir: elysionDir, rootPath: root.path ?? null });

  let instance = new Elysia()
    .use(
      await staticPlugin({
        assets: resolve(cwd, ".elyra", "client"),
        prefix: "/_client",
      })
    )
    .use(await staticPlugin());

  for (const route of routes) {
    instance = instance.use(createRoutePlugin(route, root));
  }

  // Pre-render SSG routes with staticParams before the first request arrives.
  const ssgTargets = routes.filter((r) => r.mode === "ssg" && r.page?.staticParams);
  if (ssgTargets.length > 0) {
    instance = instance.onStart(async ({ server }) => {
      const origin = server?.url?.origin ?? "http://localhost:3000";
      console.log(`[elyra] Warming SSG cache for ${ssgTargets.length} route(s)…`);
      await warmSSGCache(ssgTargets, root, origin);
      console.log("[elyra] SSG warm-up complete.");
    });
  }

  return instance;
}
