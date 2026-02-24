import type { Plugin } from "vite";
import { type ResolvedRoute, type RootLayout, scanPages } from "../router";
import { generateHydrateEntry } from "./entry-client";

interface ElysionPluginOptions {
  pagesDir: string;
}

export function elysionPlugin(options: ElysionPluginOptions): Plugin {
  const virtualRoutesId = "virtual:elysion-routes";
  const virtualEntryId = "virtual:elysion-entry-client";

  let routes: ResolvedRoute[] = [];
  let root: RootLayout | null = null;

  return {
    name: "elysion",
    async configResolved() {
      const scanResult = await scanPages(options.pagesDir);
      routes = scanResult.routes;
      root = scanResult.root;
    },
    resolveId(id) {
      if (id === virtualRoutesId) {
        return virtualRoutesId;
      }
      if (id === virtualEntryId) {
        return virtualEntryId;
      }
      return null;
    },
    load(id) {
      if (id === virtualRoutesId) {
        const routeData = routes.map((r) => ({
          pattern: r.pattern,
          path: r.pagePath,
          routeChain: r.routeChain,
        }));
        return `export const routes = ${JSON.stringify(routeData)};`;
      }
      if (id === virtualEntryId) {
        return generateHydrateEntry(routes, root);
      }
      return null;
    },
    transformIndexHtml(html) {
      return html
        .replace(
          "<head>",
          `<head>
        <script id="__ELYSION_DATA__" type="application/json"></script>`
        )
        .replace("</body>", `<script type="module" src="${virtualEntryId}"></script></body>`);
    },
    handleHotUpdate({ file, server }) {
      // Invalidate module cache when page files change
      if (file.includes("/pages/")) {
        const mod = server.moduleGraph.getModuleById(`\0${virtualRoutesId}`);
        if (mod) {
          server.moduleGraph.invalidateModule(mod);
        }
      }
    },
  };
}
