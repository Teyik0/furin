import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { staticPlugin } from "@elysiajs/static";
import { Elysia, file } from "elysia";
import { type DrainContext, initLogger } from "evlog";
import { type EvlogElysiaOptions, evlog } from "evlog/elysia";
import type { EmbeddedAppData } from "./internal.ts";
import { getCompileContext } from "./internal.ts";
import { warmSSGCache } from "./render/index.ts";
import { setProductionTemplateContent, setProductionTemplatePath } from "./render/template.ts";
import { createRoutePlugin, loadProdRoutes } from "./router.ts";
import { IS_DEV } from "./runtime-env.ts";

function resolveClientDirFromArgv(): string {
  return (
    resolveClientDirFromEnv() ??
    resolveClientDirFromModuleUrl() ??
    resolveClientDirFromProcessArgs() ??
    resolveFallbackClientDir()
  );
}

function resolveClientDirFromEnv(): string | null {
  const envClientDir = process.env.FURIN_CLIENT_DIR;
  if (!envClientDir) {
    return null;
  }
  return envClientDir.startsWith("/") ? envClientDir : resolve(process.cwd(), envClientDir);
}

function resolveClientDirFromModuleUrl(): string | null {
  try {
    const moduleUrl = new URL(import.meta.url);
    if (moduleUrl.protocol !== "file:") {
      return null;
    }
    const modulePath = fileURLToPath(moduleUrl);
    if (modulePath.includes("/$bunfs/")) {
      return null;
    }
    const moduleClientDir = join(dirname(modulePath), "client");
    if (existsSync(join(moduleClientDir, "index.html"))) {
      return moduleClientDir;
    }
  } catch {
    // ignore, fallback to argv-based resolution
  }
  return null;
}

function resolveClientDirFromProcessArgs(): string | null {
  const candidates = [
    process.argv[1],
    process.argv[0],
    (process as { argv0?: string }).argv0,
    process.execPath,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const candidate of candidates) {
    const resolved = resolveClientDirFromCandidate(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function resolveClientDirFromCandidate(candidate: string): string | null {
  const name = basename(candidate);
  if (name === "bun" || name === "node") {
    return null;
  }
  if (candidate.includes("/$bunfs/") || candidate.startsWith("bunfs:")) {
    return null;
  }

  const absolute = candidate.startsWith("/") ? candidate : resolve(process.cwd(), candidate);
  if (existsSync(absolute)) {
    return join(dirname(absolute), "client");
  }

  if (!candidate.includes("/")) {
    return resolveClientDirFromPath(candidate);
  }

  return null;
}

function resolveClientDirFromPath(candidate: string): string | null {
  const pathEntries = process.env.PATH?.split(":") ?? [];
  for (const dir of pathEntries) {
    const fullPath = join(dir, candidate);
    if (existsSync(fullPath)) {
      return join(dirname(fullPath), "client");
    }
  }
  return null;
}

function resolveFallbackClientDir(): string {
  const defaultClientDir = resolve(process.cwd(), ".furin/build/bun/client");
  if (existsSync(join(defaultClientDir, "index.html"))) {
    return defaultClientDir;
  }

  return join(process.cwd(), "client");
}

async function setupProdTemplate(
  embedded: EmbeddedAppData | undefined,
  clientDir: string
): Promise<void> {
  if (embedded) {
    if (!embedded.template) {
      throw new Error("[furin] Embedded app is missing its HTML template (index.html).");
    }
    const html = await Bun.file(embedded.template).text();
    setProductionTemplateContent(html);
    return;
  }

  const templatePath = join(clientDir, "index.html");
  if (!existsSync(templatePath)) {
    throw new Error("[furin] No pre-built assets found. Run `bun run build` first.");
  }
  setProductionTemplatePath(templatePath);
}

/**
 * Main Furin plugin.
 *
 * Returns a standalone Elysia instance (async function) so that routes are
 * properly registered in Elysia's router for SPA navigation to work.
 *
 * ## Usage
 *
 * ```ts
 * new Elysia()
 *   .use(await furin({ ... }))
 *   .listen(3000)
 * ```
 */
export async function furin({
  pagesDir,
  logger,
}: {
  pagesDir?: string;
  logger?: EvlogElysiaOptions;
}) {
  const { exclude: userExclude, ...evlogOptions } = logger ?? {};
  initLogger({ env: { service: "furin" } });

  const loggerPlugin = new Elysia()
    .use(
      evlog({
        ...evlogOptions,
        exclude: [
          "/_client/**",
          "/public/**",
          "/favicon.ico",
          "/_furin/!(ingest)",
          "/_bun_hmr_entry/**",
          ...(userExclude ?? []),
        ],
      })
    )
    .post("/_furin/ingest", ({ body, log, status }) => {
      if (!Array.isArray(body)) {
        return status("Bad Request");
      }
      const batch = body as DrainContext[];
      for (const entry of batch) {
        if (!entry || typeof entry !== "object" || !("event" in entry)) {
          log.set({ msg: "[furin] ingest: skipping malformed entry", entry });
          continue;
        }
        log.set({ ...entry.event, service: "furin:browser" });
      }
      return status("No Content");
    });

  const cwd = process.cwd();
  const ctx = getCompileContext();
  const resolvedPagesDir = ctx?.rootPath
    ? dirname(ctx.rootPath)
    : resolve(cwd, pagesDir ?? "src/pages");

  // Unique name per pagesDir to avoid Elysia's name-based plugin dedup.
  const instanceName = `furin-${resolvedPagesDir.replaceAll("\\", "/")}`;

  // ── Dev: Bun native HMR ────────────────────────────────────────────────
  if (IS_DEV) {
    const furinDir = resolve(cwd, ".furin");
    // Lazy import — build pipeline has native deps not available in compiled binaries
    const { scanPages } = await import("./router.ts");
    const { writeDevFiles } = await import("./build/hydrate.ts");
    const { registerDevPagePlugin } = await import("./dev-page-plugin.ts");

    registerDevPagePlugin();

    const { root, routes } = await scanPages(resolvedPagesDir);
    writeDevFiles(routes, { outDir: furinDir, rootLayout: root.path }, cwd);

    return new Elysia({ name: instanceName, seed: resolvedPagesDir })
      .use(loggerPlugin)
      .get("/favicon.ico", file(join(resolve(cwd, "public"), "favicon.ico")))
      .use(await staticPlugin({ assets: furinDir, prefix: "/_bun_hmr_entry" }))
      .use(await staticPlugin())
      .use((app) => {
        for (const route of routes) {
          app.use(createRoutePlugin(route, root));
        }
        return app;
      });
  }

  // ── Production ──────────────────────────────────────────────────────────
  if (!ctx) {
    throw new Error("[furin] No pre-built assets found. Run `bunx furin build` first.");
  }
  const { root, routes } = loadProdRoutes(ctx);

  const embedded = ctx?.embedded;
  const clientDir = embedded ? "" : resolveClientDirFromArgv();
  await setupProdTemplate(embedded, clientDir);

  return new Elysia({ name: instanceName, seed: resolvedPagesDir })
    .use(loggerPlugin)
    .onStart(async ({ server }) => {
      const origin = server?.url?.origin ?? "http://localhost:3000";
      await warmSSGCache(routes, root, origin);
    })
    .use(
      await (async () => {
        if (embedded) {
          return new Elysia()
            .get("/favicon.ico", ({ status }) => {
              const asset = embedded.assets["/public/favicon.ico"];
              if (!asset) {
                return status("Not Found");
              }
              return Bun.file(asset);
            })
            .get("/_client/*", ({ params, status }) => {
              const asset = embedded.assets[`/_client/${params["*"]}`];
              if (!asset) {
                return status("Not Found");
              }
              return Bun.file(asset);
            })
            .get("/public/*", ({ params, status }) => {
              const asset = embedded.assets[`/public/${params["*"]}`];
              if (!asset) {
                return status("Not Found");
              }
              return Bun.file(asset);
            });
        }
        const publicDir = join(dirname(clientDir), "public");
        const app = new Elysia();
        if (existsSync(publicDir)) {
          app
            .get("/favicon.ico", file(join(publicDir, "favicon.ico")))
            .use(await staticPlugin({ assets: publicDir, prefix: "/public" }));
        }
        app.use(await staticPlugin({ assets: clientDir, prefix: "/_client" }));
        return app;
      })()
    )
    .use((app) => {
      for (const route of routes) {
        app.use(createRoutePlugin(route, root));
      }
      return app;
    });
}
