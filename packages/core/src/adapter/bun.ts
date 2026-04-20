import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClient } from "../build/client.ts";
import { generateCompileEntry } from "../build/compile-entry.ts";
import { generateServerRoutesEntry } from "../build/server-routes-entry.ts";
import { buildTargetManifest, copyDirRecursive, ensureDir, toPosixPath } from "../build/shared.ts";
import type { BuildAppOptions, TargetBuildManifest } from "../build/types.ts";
import type { BuildTarget } from "../config.ts";
import { generateProdIndexHtml } from "../render/shell.ts";
import type { ResolvedRoute, RootLayout } from "../router.ts";

// import.meta.resolve() runs at runtime (not inlined at bundle time), resolves
// through package exports, and is the Web-standard API.
const _pkgSrcDir = dirname(fileURLToPath(import.meta.resolve("@teyik0/furin")));
const BUILD_ID_INPUT_PATHS = [
  `${_pkgSrcDir}/build/compile-entry.ts`,
  `${_pkgSrcDir}/build/entry-template.ts`,
  `${_pkgSrcDir}/build/server-routes-entry.ts`,
  `${_pkgSrcDir}/render/index.ts`,
  `${_pkgSrcDir}/render/shell.ts`,
  `${_pkgSrcDir}/router.ts`,
];

async function createBuildFingerprint(
  entryChunk: string,
  cssChunks: string[],
  routes: ResolvedRoute[],
  root: RootLayout,
  serverEntry: string | null
): Promise<string> {
  const fingerprintPaths = new Set<string>([root.path, ...routes.map((route) => route.path)]);
  if (serverEntry) {
    fingerprintPaths.add(serverEntry);
  }
  for (const path of BUILD_ID_INPUT_PATHS) {
    if (!existsSync(path)) {
      // A missing framework source file would silently produce an empty-string
      // contribution to the fingerprint, making the build ID unreliable.
      console.warn(
        `[furin] Warning: build fingerprint input "${toPosixPath(path)}" is missing — ` +
          "the generated build ID may not reflect all framework changes."
      );
    }
    fingerprintPaths.add(path);
  }

  const fileParts = await Promise.all(
    [...fingerprintPaths].sort().map(async (path) => {
      const content = existsSync(path) ? await Bun.file(path).text() : "";
      return `${toPosixPath(path)}:${content}`;
    })
  );

  const routeParts = routes
    .map((route) =>
      JSON.stringify({ mode: route.mode, path: toPosixPath(route.path), pattern: route.pattern })
    )
    .sort();

  return [entryChunk, ...[...cssChunks].sort(), ...routeParts, ...fileParts].join("\n");
}

function buildCompileMetadata(root: RootLayout, routes: ResolvedRoute[]) {
  const rootConventions = {
    errorPath: root.errorPath ? toPosixPath(root.errorPath) : undefined,
    notFoundPath: root.notFoundPath ? toPosixPath(root.notFoundPath) : undefined,
  };

  const routeMetadata: NonNullable<Parameters<typeof generateCompileEntry>[0]["routeMetadata"]> =
    {};
  for (const route of routes) {
    routeMetadata[toPosixPath(route.path)] = {
      segmentBoundaries: route.segmentBoundaries.map((b) => ({
        depth: b.depth,
        path: toPosixPath(b.path),
        errorPath: b.errorPath ? toPosixPath(b.errorPath) : undefined,
        notFoundPath: b.notFoundPath ? toPosixPath(b.notFoundPath) : undefined,
      })),
    };
  }

  return { rootConventions, routeMetadata };
}

export async function buildBunTarget(
  routes: ResolvedRoute[],
  rootDir: string,
  buildRoot: string,
  root: RootLayout,
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

  const { entryChunk, cssChunks } = await buildClient(routes, {
    outDir: targetDir,
    rootLayout: root.path,
    plugins: options.plugins,
    publicPath: "/_client/",
    basePath: "",
  });

  const buildFingerprint = await createBuildFingerprint(
    entryChunk,
    cssChunks,
    routes,
    root,
    serverEntry
  );
  const buildId = Bun.hash(buildFingerprint).toString(16).slice(0, 12);
  targetManifest.buildId = buildId;

  // Write index.html with the buildId meta tag injected so the client can
  // detect stale deploys via X-Furin-Build-ID header comparison.
  const clientDir = join(targetDir, "client");
  writeFileSync(
    join(clientDir, "index.html"),
    generateProdIndexHtml(entryChunk, cssChunks, buildId)
  );

  const routeManifest = routes.map((r) => ({ pattern: r.pattern, path: r.path, mode: r.mode }));
  const publicDir = existsSync(join(rootDir, "public")) ? join(rootDir, "public") : undefined;
  const targetPublicDir = publicDir ? join(targetDir, "public") : undefined;

  if (publicDir && targetPublicDir && options.compile !== "embed") {
    copyDirRecursive(publicDir, targetPublicDir);
  }

  const { rootConventions, routeMetadata } = buildCompileMetadata(root, routes);

  if (options.compile && serverEntry) {
    const clientDir = join(targetDir, "client");
    const outfile = join(targetDir, "server");

    const entryPath = generateCompileEntry({
      buildId,
      rootPath: root.path,
      routes: routeManifest,
      serverEntry,
      outDir: targetDir,
      embed: options.compile === "embed" ? { clientDir } : undefined,
      publicDir,
      rootConventions,
      routeMetadata,
    });

    await Bun.build({
      entrypoints: [entryPath],
      compile: { outfile },
      minify: true,
      sourcemap: "linked",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
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
      rootPath: root.path,
      routes: routeManifest,
      serverEntry,
      outDir: targetDir,
      rootConventions,
      routeMetadata,
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
  // NOTE: "index.html" is intentionally absent — generateProdIndexHtml writes
  // the final artifact to client/index.html (inside targetDir/client/), not to
  // targetDir directly, so there is nothing to remove here.
  for (const file of [
    "_compile-entry.ts",
    "_compile-entry.js.map",
    "server.ts", // disk mode intermediate
    "_hydrate.tsx",
  ]) {
    rmSync(join(targetDir, file), { force: true });
  }

  return targetManifest;
}
