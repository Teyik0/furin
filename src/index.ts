import { staticPlugin } from "@elysiajs/static";
import type { StaticOptions } from "@elysiajs/static/types";
import { Elysia } from "elysia";
import { scanPages } from "./router";

interface ElysionProps {
  pagesDir?: string;
  staticOptions: StaticOptions<string>;
}

export async function elysion({ pagesDir, staticOptions }: ElysionProps) {
  const routes = await scanPages(pagesDir ?? "./src/pages");
  console.log(`Configuration: ${routes.length} page(s)`);
  for (const route of routes) {
    const modeLabel = route.mode.toUpperCase();
    const hasAction = route.module.options?.action ? " + action" : "";
    console.log(`${modeLabel.padEnd(4)} ${route.pattern}${hasAction}`);
  }

  const plugin = new Elysia();
  return new Elysia().use(await staticPlugin(staticOptions)).listen(3000);
}

// biome-ignore lint/performance/noBarrelFile: library entrypoint
export { page } from "./page";
