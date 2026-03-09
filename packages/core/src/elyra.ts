import { resolve } from "node:path";
import { staticPlugin } from "@elysiajs/static";
import { Elysia } from "elysia";
import { buildClient, readTargetBuildManifest, writeDevFiles } from "./build";
import { warmSSGCache } from "./render/index";
import { setProductionTemplatePath } from "./render/template";
import { createRoutePlugin, scanPages } from "./router";
import { IS_DEV } from "./runtime-env";

export interface ElysionProps {
  pagesDir?: string;
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
  const buildTarget = process.env.ELYRA_BUILD_TARGET;
  const buildOutDir = process.env.ELYRA_BUILD_OUT_DIR;
  const prebuiltManifest =
    !IS_DEV && buildTarget === "bun" ? readTargetBuildManifest(cwd, "bun", buildOutDir) : null;

  const { root, routes } = await scanPages(resolvedPagesDir);

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
    writeDevFiles(routes, { outDir: elysionDir, rootLayout: root.path });

    let instance = new Elysia()
      .use(
        await staticPlugin({
          assets: elysionDir,
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
  const defaultProdDir = resolve(cwd, ".elyra");
  const elysionDir = prebuiltManifest ? resolve(cwd, prebuiltManifest.targetDir) : defaultProdDir;

  if (prebuiltManifest) {
    setProductionTemplatePath(resolve(cwd, prebuiltManifest.templatePath));
  } else {
    setProductionTemplatePath(null);
    await buildClient(routes, { outDir: elysionDir, rootLayout: root.path });
  }

  let instance = new Elysia()
    .use(
      await staticPlugin({
        assets: prebuiltManifest
          ? resolve(cwd, prebuiltManifest.clientDir)
          : resolve(cwd, ".elyra", "client"),
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
