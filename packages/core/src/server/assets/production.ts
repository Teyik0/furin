import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { staticPlugin } from "@elysia/static";
import { type AnyElysia, Elysia, file } from "elysia";
import type { CompileContext, EmbeddedAppData } from "../internal.ts";

function resolveEmbeddedAssetPath(directory: string, requestPath: string): string | null {
  const assetPath = resolve(directory, requestPath);
  const pathFromDirectory = relative(directory, assetPath);
  if (
    pathFromDirectory === "" ||
    pathFromDirectory === ".." ||
    pathFromDirectory.startsWith(`..${sep}`) ||
    isAbsolute(pathFromDirectory)
  ) {
    return null;
  }
  return assetPath;
}

async function loadEmbeddedAsset(
  directory: string,
  requestPath: string
): Promise<ReturnType<typeof Bun.file> | null> {
  const assetPath = resolveEmbeddedAssetPath(directory, requestPath);
  if (assetPath === null) {
    return null;
  }
  const asset = Bun.file(assetPath);
  return (await asset.exists()) ? asset : null;
}

function createEmbeddedAssetsPlugin(embedded: EmbeddedAppData): AnyElysia {
  const { clientDir, publicDir } = embedded;
  if (!publicDir) {
    return new Elysia().get("/_client/*", async ({ params, set, status }) => {
      const asset = await loadEmbeddedAsset(clientDir, params["*"]);
      if (asset === null) {
        return status("Not Found");
      }
      set.headers["cache-control"] = "public, max-age=31536000, immutable";
      return asset;
    });
  }

  return new Elysia()
    .get("/favicon.ico", async ({ status }) => {
      const asset = await loadEmbeddedAsset(publicDir, "favicon.ico");
      return asset ?? status("Not Found");
    })
    .get("/public/*", async ({ params, set, status }) => {
      const asset = await loadEmbeddedAsset(publicDir, params["*"]);
      if (asset === null) {
        return status("Not Found");
      }
      set.headers["cache-control"] = "public, max-age=86400";
      return asset;
    })
    .get("/_client/*", async ({ params, set, status }) => {
      const asset = await loadEmbeddedAsset(clientDir, params["*"]);
      if (asset === null) {
        return status("Not Found");
      }
      set.headers["cache-control"] = "public, max-age=31536000, immutable";
      return asset;
    });
}

export async function createProductionAssetsPlugin(
  ctx: CompileContext,
  embedded: EmbeddedAppData | undefined,
  clientDir: string
): Promise<AnyElysia> {
  if (ctx.serveAssets === false) {
    return new Elysia();
  }
  if (embedded) {
    // @elysia/static scans with Bun.Glob, which cannot open BunFS directories
    // in Bun 1.4.0. Direct file lookup also avoids enumerating assets at startup.
    return createEmbeddedAssetsPlugin(embedded);
  }

  const publicDir = join(dirname(clientDir), "public");
  const publicAssets = existsSync(publicDir)
    ? new Elysia()
        .get("/favicon.ico", file(join(publicDir, "favicon.ico")))
        .use(await staticPlugin({ assets: publicDir, prefix: "/public" }))
    : new Elysia();

  return publicAssets.use(
    await staticPlugin({
      assets: clientDir,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
      },
      prefix: "/_client",
    })
  );
}
