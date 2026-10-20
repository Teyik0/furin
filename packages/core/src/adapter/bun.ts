import { existsSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { runBunBuild } from "../build/bun-build.ts";
import { PRERENDER_SNAPSHOT_FILE } from "../build/entry-template.ts";
import {
  movePrivateServerSourceMaps,
  privateServerSourceMapDir,
} from "../build/private-server-sourcemaps.ts";
import { toPosixPath } from "../build/shared.ts";
import type { TargetBuildManifest } from "../build/types.ts";
import { clientDirNameForPrefix } from "../shared/prefix.ts";
import { frameworkSourceModule } from "./runtime-build.ts";
import type { AdapterBuildOutput, FurinAdapter } from "./types.ts";

const RUNTIME_MODULE = frameworkSourceModule("adapter/bun/server.ts");
const APP_RUNTIME_MODULE = frameworkSourceModule("adapter/bun/app.ts");

export type BunCompileMode = "server" | "embed";
/** `server` emits a listening `server.js`, `app` an importable, inert `app.js`. */
export type BunOutput = "app" | "server";

function compiledServerFilename(platform: NodeJS.Platform): string {
  return platform === "win32" ? "server.exe" : "server";
}

/**
 * Turns the JavaScript server bundle into a standalone executable. The bundle
 * already carries the prerender snapshot, which this pass inlines.
 */
async function compileExecutable(
  output: AdapterBuildOutput,
  compile: BunCompileMode,
  manifest: TargetBuildManifest
): Promise<void> {
  const { apps, buildRoot, server } = output;
  const filename = compiledServerFilename(process.platform);
  const publicDir = join(server.dir, "public");
  const embedded =
    compile === "embed"
      ? [...apps.map((app) => app.clientDir), ...(existsSync(publicDir) ? [publicDir] : [])]
      : undefined;
  const build = await runBunBuild({
    bytecode: true,
    compile: { assets: embedded, outfile: join(server.dir, filename) },
    entrypoints: [join(server.dir, server.entry)],
    format: "esm",
    minify: true,
    sourcemap: output.serverSourceMaps ? "external" : "none",
    splitting: true,
    target: "bun",
  });
  if (output.serverSourceMaps) {
    movePrivateServerSourceMaps(
      server.dir,
      privateServerSourceMapDir(buildRoot, "bun"),
      build.outputs.filter((entry) => entry.kind === "sourcemap").map((entry) => entry.path)
    );
  }
  for (const file of [...server.files, PRERENDER_SNAPSHOT_FILE]) {
    rmSync(join(server.dir, file), { force: true });
  }
  manifest.serverPath = toPosixPath(join(manifest.targetDir, filename));
  console.log(`[furin] Server binary: ${join(server.dir, filename)}`);
  if (compile === "embed") {
    for (const app of apps) {
      rmSync(join(server.dir, clientDirNameForPrefix(app.prefix)), {
        force: true,
        recursive: true,
      });
    }
    rmSync(publicDir, { force: true, recursive: true });
    manifest.clientDir = null;
    manifest.templatePath = null;
  }
}

/**
 * Bun server bundle, optionally compiled into an executable. Requests reach
 * `Bun.serve()`, Furin serves assets and caches public pages itself.
 */
export function bun(
  compile: BunCompileMode | undefined,
  bunOutput: BunOutput | undefined
): FurinAdapter {
  const isApp = bunOutput === "app";
  if (isApp && compile !== undefined) {
    throw new Error("[furin] Bun app output cannot be combined with compile.");
  }
  return {
    capabilities: {
      assets: compile === "embed" ? "embedded" : "filesystem",
      publicCache: "framework",
      websocket: true,
    },
    name: "bun",
    async onBuildComplete(output) {
      const targetDir = toPosixPath(relative(output.rootDir, output.server.dir));
      const manifest: TargetBuildManifest = {
        buildId: output.buildId,
        clientDir: toPosixPath(join(targetDir, "client")),
        generatedAt: new Date().toISOString(),
        rscManifestPath: toPosixPath(join(targetDir, "rsc", "manifest.json")),
        serverPath: toPosixPath(join(targetDir, output.server.entry)),
        targetDir,
        templatePath: toPosixPath(join(targetDir, "client", "index.html")),
      };
      if (isApp) {
        manifest.appPath = manifest.serverPath as string;
        manifest.serverPath = null;
        console.log(`[furin] Application bundle: ${manifest.appPath}`);
        return manifest;
      }
      if (compile === undefined) {
        console.log(`[furin] Server bundle: ${manifest.serverPath}`);
        return manifest;
      }
      await compileExecutable(output, compile, manifest);
      return manifest;
    },
    runtimeModule: isApp ? APP_RUNTIME_MODULE : RUNTIME_MODULE,
  };
}
