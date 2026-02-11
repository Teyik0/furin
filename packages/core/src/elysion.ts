import { resolve } from "node:path";
import { staticPlugin } from "@elysiajs/static";
import type { StaticOptions } from "@elysiajs/static/types";
import { type AnyElysia, Elysia } from "elysia";
import { buildClient, watchPages } from "./build";
import { createRoutePlugin, scanPages } from "./router";

interface ElysionProps {
  pagesDir?: string;
  staticOptions: StaticOptions<string>;
  dev?: boolean;
}

export async function elysion({
  pagesDir,
  staticOptions,
  dev = process.env.NODE_ENV !== "production",
}: ElysionProps) {
  const resolvedPagesDir = resolve(process.cwd(), pagesDir ?? "./src/pages");
  const routes = await scanPages(resolvedPagesDir);

  await buildClient(routes, { dev });
  if (dev) {
    watchPages(resolvedPagesDir, routes);
  }

  const plugins: AnyElysia[] = [];

  console.log(`Configuration: ${routes.length} page(s)`);
  for (const route of routes) {
    const modeLabel = route.mode.toUpperCase();
    const hasAction = route.module.options?.action ? " + action" : "";
    console.log(`${modeLabel.padEnd(4)} ${route.pattern}${hasAction}`);

    plugins.push(createRoutePlugin(route, staticOptions));
  }

  // Serve the client hydration bundle from .elysion/client/ at /_client/
  const clientStaticPlugin = await staticPlugin({
    assets: resolve(process.cwd(), ".elysion", "client"),
    prefix: "/_client",
  });

  return plugins.reduce(
    (app, plugin) => app.use(plugin),
    new Elysia().use(clientStaticPlugin).use(await staticPlugin(staticOptions))
  );
}
