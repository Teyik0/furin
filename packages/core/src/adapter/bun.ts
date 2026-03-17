import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildClient } from "../build/client.ts";
import { generateCompileEntry } from "../build/compile-entry.ts";
import { generateServerRoutesEntry } from "../build/server-routes-entry.ts";
import { buildTargetManifest, copyDirRecursive, ensureDir, toPosixPath } from "../build/shared.ts";
import type { BuildAppOptions, TargetBuildManifest } from "../build/types.ts";
import type { BuildTarget } from "../config.ts";
import type { ResolvedRoute } from "../router.ts";

export async function buildBunTarget(
  routes: ResolvedRoute[],
  rootDir: string,
  buildRoot: string,
  rootPath: string,
  serverEntry: string | null,
  options: BuildAppOptions
): Promise<TargetBuildManifest> {
  if (options.compile && !serverEntry) {
    throw new Error(
      `[furin] \`compile: "${options.compile}"\` requires a server entry point. ` +
        "Create src/server.ts or set `serverEntry` in your furin.config.ts."
    );
  }

  const target = "bun" satisfies BuildTarget;
  const targetManifest = buildTargetManifest(rootDir, buildRoot, target, serverEntry);
  const targetDir = resolve(rootDir, targetManifest.targetDir);

  rmSync(targetDir, { force: true, recursive: true });
  ensureDir(targetDir);

  await buildClient(routes, {
    outDir: targetDir,
    rootLayout: rootPath,
    plugins: options.plugins,
  });

  // Generate a deterministic build ID from the produced index.html.
  // The index.html contains content-hashed chunk filenames, so any JS/CSS
  // change causes a new build ID — without any CDN purge needed.
  const clientIndexPath = join(targetDir, "client/index.html");
  const clientIndexContent = readFileSync(clientIndexPath, "utf8");
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(clientIndexContent);
  const buildId = hasher.digest("hex").slice(0, 16);

  // Inject the build ID into the SSR template so every rendered page carries
  // <meta name="furin-build-id"> — used by the client to detect stale deploys.
  writeFileSync(
    clientIndexPath,
    clientIndexContent.replace(
      "<!--ssr-head-->",
      `<meta name="furin-build-id" content="${buildId}">\n  <!--ssr-head-->`
    )
  );

  const routeManifest = routes.map((r) => ({ pattern: r.pattern, path: r.path, mode: r.mode }));
  const publicDir = existsSync(join(rootDir, "public")) ? join(rootDir, "public") : undefined;
  const targetPublicDir = publicDir ? join(targetDir, "public") : undefined;

  if (publicDir && targetPublicDir && options.compile !== "embed") {
    copyDirRecursive(publicDir, targetPublicDir);
  }

  if (options.compile && serverEntry) {
    const clientDir = join(targetDir, "client");
    const outfile = join(targetDir, "server");

    const entryPath = generateCompileEntry({
      buildId,
      rootPath,
      routes: routeManifest,
      serverEntry,
      outDir: targetDir,
      embed: options.compile === "embed" ? { clientDir } : undefined,
      publicDir,
    });

    await Bun.build({
      entrypoints: [entryPath],
      compile: { outfile },
      minify: true,
      sourcemap: "linked",
      plugins: options.plugins,
    });
    console.log(`[furin] Server binary: ${outfile}`);

    targetManifest.serverPath = toPosixPath(join(targetManifest.targetDir, "server"));

    // Embed mode: assets are in the binary — clean up client dir too.
    if (options.compile === "embed") {
      rmSync(clientDir, { force: true, recursive: true });
      targetManifest.clientDir = null;
      targetManifest.templatePath = null;
    }
  } else if (serverEntry) {
    // Disk mode: generate server.ts then bundle it into self-contained server.js
    const entryPath = generateServerRoutesEntry({
      buildId,
      rootPath,
      routes: routeManifest,
      serverEntry,
      outDir: targetDir,
    });

    await Bun.build({
      entrypoints: [entryPath],
      outdir: targetDir,
      target: "bun",
      minify: true,
      sourcemap: "linked",
      plugins: options.plugins,
    });
    console.log(
      `[furin] Server bundle: ${toPosixPath(join(targetManifest.targetDir, "server.js"))}`
    );

    targetManifest.serverPath = toPosixPath(join(targetManifest.targetDir, "server.js"));
  }

  // Clean up build intermediates — no longer needed once the bundle/binary is built.
  for (const file of [
    "_compile-entry.ts",
    "_compile-entry.js.map",
    "server.ts", // disk mode intermediate
    "_hydrate.tsx",
    "index.html",
  ]) {
    rmSync(join(targetDir, file), { force: true });
  }

  return targetManifest;
}
