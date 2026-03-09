import { rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildClient } from "../build/client";
import {
  buildTargetManifest,
  CLIENT_MODULE_PATH,
  ensureDir,
  LINK_MODULE_PATH,
  rewriteFrameworkImports,
  toImportSpecifier,
  toPosixPath,
  writeJsonFile,
} from "../build/shared";
import type { BuildAppOptions, BunBuildAliasConfig, TargetBuildManifest } from "../build/types";
import type { BuildTarget } from "../config";
import type { ResolvedRoute } from "../router";

const TS_FILE_FILTER = /\.(tsx|ts)$/;

function generateNodeRuntimeModule(
  routes: ResolvedRoute[],
  rootPath: string,
  targetDir: string
): string {
  const routerModulePath = resolve(import.meta.dir, "../router.ts");
  const utilsModulePath = resolve(import.meta.dir, "../utils.ts");
  const rootImportPath = toImportSpecifier(targetDir, rootPath);
  const routerImportPath = toImportSpecifier(targetDir, routerModulePath);
  const utilsImportPath = toImportSpecifier(targetDir, utilsModulePath);

  const pageImports = routes
    .map(
      (route, index) => `import page${index} from "${toImportSpecifier(targetDir, route.path)}";`
    )
    .join("\n");

  const routeEntries = routes
    .map((route, index) => {
      const pageVar = `page${index}`;
      return [
        "(() => {",
        `  const page = ${pageVar};`,
        "  const routeChain = collectRouteChain(page);",
        "  return {",
        `    pattern: ${JSON.stringify(route.pattern)},`,
        "    page,",
        `    pagePath: ${JSON.stringify(route.path)},`,
        `    path: ${JSON.stringify(route.path)},`,
        "    routeChain,",
        "    mode: resolveMode(page, routeChain),",
        "  };",
        "})()",
      ].join("\n");
    })
    .join(",\n");

  return [
    `import * as rootModule from "${rootImportPath}";`,
    pageImports,
    `import { resolveMode } from "${routerImportPath}";`,
    `import { collectRouteChain } from "${utilsImportPath}";`,
    "",
    `const rootRoute = "route" in rootModule ? rootModule.route : rootModule["default"];`,
    "",
    "export const root = {",
    `  path: ${JSON.stringify(rootPath)},`,
    "  route: rootRoute,",
    "};",
    "",
    "export const routes = [",
    routeEntries,
    "];",
    "",
  ].join("\n");
}

function generateNodeServerEntry(targetDir: string): string {
  const routerModulePath = resolve(import.meta.dir, "../router.ts");
  const templateModulePath = resolve(import.meta.dir, "../render/template.ts");
  const routerImportPath = toImportSpecifier(targetDir, routerModulePath);
  const templateImportPath = toImportSpecifier(targetDir, templateModulePath);

  return [
    `import { createServer } from "node:http";`,
    `import { fileURLToPath } from "node:url";`,
    `import { Readable } from "node:stream";`,
    `import { Elysia } from "elysia";`,
    `import { staticPlugin } from "@elysiajs/static";`,
    `import { createRoutePlugin } from "${routerImportPath}";`,
    `import { setProductionTemplatePath } from "${templateImportPath}";`,
    `import { root, routes } from "./runtime";`,
    "",
    `const clientDir = fileURLToPath(new URL("./client", import.meta.url));`,
    `const templatePath = fileURLToPath(new URL("./client/index.html", import.meta.url));`,
    "setProductionTemplatePath(templatePath);",
    "",
    "let app = new Elysia()",
    `  .use(await staticPlugin({ assets: clientDir, prefix: "/_client" }))`,
    "  .use(await staticPlugin());",
    "",
    "for (const route of routes) {",
    "  app = app.use(createRoutePlugin(route, root));",
    "}",
    "",
    "function toRequest(req, port) {",
    '  const origin = "http://" + (req.headers.host ?? "127.0.0.1:" + port);',
    `  const url = new URL(req.url ?? "/", origin);`,
    "  const headers = new Headers();",
    "  for (const [key, value] of Object.entries(req.headers)) {",
    "    if (Array.isArray(value)) {",
    "      for (const item of value) headers.append(key, item);",
    "    } else if (value !== undefined) {",
    "      headers.set(key, value);",
    "    }",
    "  }",
    `  const method = req.method ?? "GET";`,
    "  return new Request(url, {",
    "    method,",
    "    headers,",
    `    body: method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(req),`,
    `    duplex: "half",`,
    "  });",
    "}",
    "",
    "const port = Number(process.env.PORT ?? 3000);",
    "const server = createServer(async (req, res) => {",
    "  const response = await app.fetch(toRequest(req, port));",
    "  res.statusCode = response.status;",
    "  const setCookies = response.headers.getSetCookie();",
    "  response.headers.forEach((value, key) => {",
    "    if (key.toLowerCase() !== 'set-cookie') res.setHeader(key, value);",
    "  });",
    "  if (setCookies.length > 0) res.setHeader('set-cookie', setCookies);",
    "  if (!response.body) {",
    "    res.end();",
    "    return;",
    "  }",
    "  Readable.fromWeb(response.body).pipe(res);",
    "});",
    "",
    "server.listen(port, () => {",
    '  console.log("[elyra:node] listening on " + port);',
    "});",
    "",
  ].join("\n");
}

export async function buildNodeTarget(
  routes: ResolvedRoute[],
  rootDir: string,
  buildRoot: string,
  rootPath: string,
  serverEntry: string | null,
  options: BuildAppOptions
): Promise<TargetBuildManifest> {
  const target = "node" satisfies BuildTarget;
  const targetManifest = buildTargetManifest(rootDir, buildRoot, target, serverEntry);
  const targetDir = resolve(rootDir, targetManifest.targetDir);
  const runtimeEntryPath = join(targetDir, "runtime.ts");
  const serverEntryPath = join(targetDir, "server.entry.ts");
  const outputServerPath = join(targetDir, "server.js");

  rmSync(targetDir, { force: true, recursive: true });
  ensureDir(targetDir);

  await buildClient(routes, {
    outDir: targetDir,
    rootLayout: rootPath,
  });

  writeFileSync(runtimeEntryPath, generateNodeRuntimeModule(routes, rootPath, targetDir));
  writeFileSync(serverEntryPath, generateNodeServerEntry(targetDir));

  const nodeRuntimePlugin: Bun.BunPlugin = {
    name: "elyra-rewrite-framework-imports",
    setup(build) {
      build.onLoad({ filter: TS_FILE_FILTER }, async (args) => {
        const { path } = args;
        if (path.includes("node_modules")) {
          return undefined;
        }

        const code = await Bun.file(path).text();
        return {
          contents: rewriteFrameworkImports(code),
          loader: path.endsWith(".tsx") ? "tsx" : "ts",
        };
      });
    },
  };

  const serverBuildConfig: BunBuildAliasConfig = {
    entrypoints: [serverEntryPath],
    outfile: outputServerPath,
    write: false,
    target: "node",
    format: "esm",
    packages: "external",
    minify: options.minify ?? true,
    sourcemap: (options.sourcemap ?? false) ? "external" : "none",
    plugins: [nodeRuntimePlugin],
    alias: {
      "elyra/client": CLIENT_MODULE_PATH,
      "elyra/link": LINK_MODULE_PATH,
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  };

  const serverBuild = await Bun.build(serverBuildConfig);

  if (!serverBuild.success) {
    const errorOutput = serverBuild.logs.map((log) => log.message).join("\n");
    throw new Error(`[elyra] Node server build failed\n${errorOutput}`.trim());
  }

  const serverOutput = serverBuild.outputs.find((output) =>
    output.type.startsWith("text/javascript")
  );
  if (!serverOutput) {
    throw new Error("[elyra] Node server build did not emit a JavaScript bundle");
  }

  writeFileSync(outputServerPath, await serverOutput.text());

  const sourceMapOutput = serverBuild.outputs.find((output) => output.type.includes("json"));
  if (sourceMapOutput && (options.sourcemap ?? false)) {
    writeFileSync(`${outputServerPath}.map`, await sourceMapOutput.text());
  }

  targetManifest.serverPath = toPosixPath(relative(rootDir, outputServerPath));
  writeJsonFile(resolve(rootDir, targetManifest.manifestPath), targetManifest);
  return targetManifest;
}
