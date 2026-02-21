import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { staticPlugin } from "@elysiajs/static";
import type { StaticOptions } from "@elysiajs/static/types";
import { Elysia } from "elysia";
import { buildClient } from "./build";
import { type CssOptions, getCachedCss, setCssConfig } from "./css";
import { createHmrPlugin } from "./hmr/plugin";
import { createRoutePlugin, scanPages } from "./router";

export interface ElysionProps {
  css?: CssOptions;
  dev?: boolean;
  pagesDir?: string;
  staticOptions: StaticOptions<string>;
}

async function buildExternalCss(cwd: string): Promise<void> {
  const result = await getCachedCss(cwd);
  if (!result || result.mode !== "external") {
    return;
  }

  const clientDir = resolve(cwd, ".elysion", "client");
  if (!existsSync(clientDir)) {
    mkdirSync(clientDir, { recursive: true });
  }
  await Bun.write(resolve(clientDir, "styles.css"), result.code);
  console.log("[elysion] CSS built: /_client/styles.css");
}

export async function elysion({
  pagesDir,
  staticOptions,
  dev = process.env.NODE_ENV !== "production",
  css,
}: ElysionProps) {
  const cwd = process.cwd();
  const resolvedPagesDir = resolve(cwd, pagesDir ?? "./src/pages");

  // Store CSS config (lightweight, survives bun --hot)
  setCssConfig(css, dev);

  // Log CSS mode
  if (css?.input) {
    const result = await getCachedCss(cwd);
    if (result) {
      if (result.mode === "external") {
        await buildExternalCss(cwd);
      } else {
        console.log("[elysion] CSS inline mode enabled");
      }
    }
  }

  const { root, routes } = await scanPages(resolvedPagesDir, dev);

  // Warn if no root layout found
  if (!root) {
    console.warn(
      "[elysion] No root.tsx found. Create a root.tsx file in your pages directory " +
        "that exports a root layout with <html>, <head>, and <body> tags."
    );
  }

  const clientBundlePath = resolve(cwd, ".elysion", "client", "_hydrate.js");
  // In dev mode, skip the rebuild if the bundle already exists on disk.
  // elysion() is re-called on every bun --hot reload (whenever a watched file
  // changes), but the dev bundle is route-agnostic: page modules are served
  // individually at /_modules/src/*. Rebuilding on every hot reload triggers
  // "Unseekable file" errors because React lives in Bun's .bun/ local cache,
  // which Bun.build() cannot seek through after the initial build.
  const shouldBuildClient = dev ? !existsSync(clientBundlePath) : true;

  if (shouldBuildClient) {
    await buildClient(routes, { dev, rootPath: root?.path ?? null });
  } else {
    console.log("[elysion] Using existing client bundle (HMR mode)");
  }

  console.log(`[elysion] Configuration: ${routes.length} page(s)`);
  if (dev) {
    console.log("[elysion] HMR enabled - modifying pages will hot reload without server restart");
  }

  for (const route of routes) {
    const modeLabel = route.mode.toUpperCase();
    const hasLayout = route.routeChain.some((r) => r.layout);
    const layoutLabel = hasLayout ? " + layout" : "";
    console.log(`  ${modeLabel.padEnd(4)} ${route.pattern}${layoutLabel}`);
  }

  const clientStaticPlugin = await staticPlugin({
    assets: resolve(cwd, ".elysion", "client"),
    prefix: "/_client",
  });

  // Build route plugins array
  const routePlugins = routes.map((route) => createRoutePlugin(route, staticOptions, root, dev));

  // Chain everything in a single expression
  const baseApp = new Elysia({
    websocket: {
      idleTimeout: 255,
    },
  })
    .use(clientStaticPlugin)
    .use(await staticPlugin(staticOptions));

  // Conditionally add HMR plugin
  const appWithHmr = dev ? baseApp.use(createHmrPlugin(resolvedPagesDir, css?.input)) : baseApp;

  // Chain all route plugins
  return routePlugins.reduce((app, plugin) => app.use(plugin), appWithHmr);
}

import.meta.hot.accept();
