import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { staticPlugin } from "@elysiajs/static";
import type { StaticOptions } from "@elysiajs/static/types";
import { Elysia } from "elysia";
import { buildClient } from "./build";
import { createHmrPlugin } from "./hmr/plugin";
import { createRoutePlugin, scanPages } from "./router";

export interface ElysionProps {
  pagesDir?: string;
  staticOptions: StaticOptions<string>;
  dev?: boolean;
}

declare global {
  var __elysionClientBuilt: boolean;
}

export async function elysion({
  pagesDir,
  staticOptions,
  dev = process.env.NODE_ENV !== "production",
}: ElysionProps) {
  const resolvedPagesDir = resolve(process.cwd(), pagesDir ?? "./src/pages");

  const routes = await scanPages(resolvedPagesDir, dev);

  const clientBundlePath = resolve(process.cwd(), ".elysion", "client", "_hydrate.js");
  const shouldBuildClient = !(
    dev &&
    globalThis.__elysionClientBuilt &&
    existsSync(clientBundlePath)
  );

  if (shouldBuildClient) {
    await buildClient(routes, { dev });
    globalThis.__elysionClientBuilt = true;
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
    assets: resolve(process.cwd(), ".elysion", "client"),
    prefix: "/_client",
  });

  // Build route plugins array
  const routePlugins = routes.map((route) => createRoutePlugin(route, staticOptions, dev));

  // Chain everything in a single expression
  const baseApp = new Elysia({
    websocket: {
      idleTimeout: 255,
    },
  })
    .use(clientStaticPlugin)
    .use(await staticPlugin(staticOptions));

  // Conditionally add HMR plugin
  const appWithHmr = dev ? baseApp.use(createHmrPlugin(resolvedPagesDir)) : baseApp;

  // Chain all route plugins
  return routePlugins.reduce((app, plugin) => app.use(plugin), appWithHmr);
}

import.meta.hot.accept();
