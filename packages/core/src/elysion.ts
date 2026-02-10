import { resolve } from "node:path";
import { staticPlugin } from "@elysiajs/static";
import type { StaticOptions } from "@elysiajs/static/types";
import { type AnyElysia, Elysia } from "elysia";
import { buildPages, watchPages } from "./build";
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

  // Build client bundles first
  await buildPages(resolvedPagesDir, {
    minify: !dev,
    sourcemap: dev,
  });

  // Watch for changes in dev mode
  if (dev) {
    watchPages(resolvedPagesDir).catch(console.error);
  }

  const routes = await scanPages(resolvedPagesDir);

  const plugins: AnyElysia[] = [];

  console.log(`Configuration: ${routes.length} page(s)`);
  for (const route of routes) {
    const modeLabel = route.mode.toUpperCase();
    const hasAction = route.module.options?.action ? " + action" : "";
    console.log(`${modeLabel.padEnd(4)} ${route.pattern}${hasAction}`);

    plugins.push(createRoutePlugin(route, staticOptions));
  }

  // Serve static files from both user public/ and dist/client/
  const clientStaticOptions: StaticOptions<string> = {
    assets: resolve(process.cwd(), "dist", "client"),
    prefix: "/client",
  };

  return plugins.reduce(
    (app, plugin) => app.use(plugin),
    new Elysia()
      .use(await staticPlugin(clientStaticOptions))
      .use(await staticPlugin(staticOptions))
  );
}
