import { resolve } from "node:path";
import { staticPlugin } from "@elysiajs/static";
import type { StaticOptions } from "@elysiajs/static/types";
import { Elysia } from "elysia";
import { createRoutePlugin, scanPages } from "./router";
import { createVitePlugin } from "./vite";

export interface ElysionProps {
  dev?: boolean;
  pagesDir?: string;
  staticOptions: StaticOptions<string>;
}

export async function elysion({
  pagesDir,
  staticOptions,
  dev = process.env.NODE_ENV !== "production",
}: ElysionProps) {
  const cwd = process.cwd();
  const resolvedPagesDir = resolve(cwd, pagesDir ?? "./src/pages");

  const { root, routes } = await scanPages(resolvedPagesDir);

  if (!root) {
    throw new Error(
      "[elysion] No root.tsx found. Create a root.tsx file in your pages directory that exports a root layout with <html>, <head>, and <body> tags."
    );
  }

  for (const route of routes) {
    const modeLabel = route.mode.toUpperCase();
    const hasLayout = route.routeChain.some((r) => r.layout);
    const layoutLabel = hasLayout ? " + layout" : "";
    console.log(`  ${modeLabel.padEnd(4)} ${route.pattern}${layoutLabel}`);
  }

  const baseApp = dev
    ? new Elysia({ name: "elysion-dev" }).use(await createVitePlugin())
    : new Elysia({ name: "elysion-prod" })
        .use(
          await staticPlugin({
            assets: resolve(cwd, ".elysion", "client"),
            prefix: "/_client",
          })
        )
        .use(await staticPlugin(staticOptions));

  const routePlugins = routes.map((route) => createRoutePlugin(route, root, dev));
  return routePlugins.reduce((app, plugin) => app.use(plugin), baseApp);
}

import.meta.hot.accept();
