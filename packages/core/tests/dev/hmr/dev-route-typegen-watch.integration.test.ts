// biome-ignore-all lint/performance/noAwaitInLoops: integration polling waits for persistent process output
import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { getFreePort } from "../../support/hmr.ts";
import { waitForHttp } from "../../support/http.ts";
import { type RunningCli, startProcess } from "../../support/process.ts";

function rootRouteSource(): string {
  return [
    'import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";',
    "",
    "export const route = defineRootRoute()",
    '  .config({ mode: "ssr" })',
    "  .layout(({ children }) => (",
    '    <html lang="en"><head><HeadContent /></head><body>{children}<Scripts /></body></html>',
    "  ));",
  ].join("\n");
}

function typedRouteSource(version: "after" | "before"): string {
  const isBefore = version === "before";
  const schema = isBefore ? "t.Number()" : "t.String()";
  const message = isBefore ? "params.id + query.page" : 'params.id + ":" + query.page';
  return [
    'import { defineRoute } from "@teyik0/furin";',
    'import { t } from "elysia";',
    'import { route as rootRoute } from "../root";',
    "",
    "export const route = defineRoute()",
    "  .config({",
    "    layout: rootRoute,",
    '    mode: "ssr",',
    `    params: t.Object({ id: ${schema} }),`,
    `    query: t.Object({ page: ${schema} }),`,
    `    tags: ["${version}"],`,
    "  })",
    `  .loader(({ params, query }) => ({ message: ${message} }))`,
    "  .page(({ data }) => <main>{data.message}</main>);",
  ].join("\n");
}

function typeConsumerSource(version: "after" | "before"): string {
  const value = version === "before" ? "1" : '"1"';
  return [
    'import type { CacheTag, RouteLoaderData } from "@teyik0/furin";',
    'import type { RouteManifest, RouteParamsOf, RouteSearch } from "@teyik0/furin/link";',
    "",
    `const params: RouteParamsOf<"/items/1"> = { id: ${value} };`,
    `const query: RouteSearch<"/items/1"> = { page: ${value} };`,
    `const data: RouteLoaderData<RouteManifest["/items/1"]> = { message: ${value} };`,
    `const tag: CacheTag = "${version}";`,
    "",
    "void [params, query, data, tag];",
  ].join("\n");
}

function compilerOutput(compiler: RunningCli): string {
  return compiler.getStdout() + compiler.getStderr();
}

async function waitForCompilerMessage(
  compiler: RunningCli,
  outputOffset: number,
  message: string
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!compilerOutput(compiler).slice(outputOffset).includes(message)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for TypeScript output "${message}".\n${compilerOutput(compiler)}`
      );
    }
    await Bun.sleep(25);
  }
}

test.serial(
  "route contract edits update a running TypeScript watcher without restarting it",
  async () => {
    const app = createTmpApp("cli-app");
    const port = await getFreePort();
    let compiler: RunningCli | undefined;
    let server: RunningCli | undefined;

    writeAppFile(app.path, "src/pages/root.tsx", rootRouteSource());
    writeAppFile(app.path, "src/pages/items/[id].tsx", typedRouteSource("before"));
    writeAppFile(app.path, "type-consumer.ts", typeConsumerSource("before"));
    writeAppFile(
      app.path,
      "tsconfig.typegen.json",
      JSON.stringify(
        {
          compilerOptions: {
            incremental: false,
          },
          extends: "../../../../tsconfig.base.json",
          include: [
            "furin-env.d.ts",
            "src/pages/items/[id].tsx",
            "src/pages/root.tsx",
            "type-consumer.ts",
          ],
        },
        null,
        2
      )
    );

    try {
      server = startProcess(["bun", "--hot", join(app.path, "src/server.ts")], {
        cwd: app.path,
        env: { PORT: String(port) },
      });
      try {
        await waitForHttp(`http://localhost:${port}/items/1?page=1`, {
          intervalMs: 100,
          timeoutMs: 20_000,
        });
      } catch (error) {
        throw new Error(
          `Development server did not become ready.\n${server.getStdout()}\n${server.getStderr()}`,
          { cause: error }
        );
      }

      compiler = startProcess(
        [
          "bun",
          "run",
          "tsc",
          "--watch",
          "--noEmit",
          "--pretty",
          "false",
          "--preserveWatchOutput",
          "--project",
          "tsconfig.typegen.json",
        ],
        { cwd: app.path }
      );
      await waitForCompilerMessage(compiler, 0, "Found 0 errors");
      const compilerPid = compiler.pid;
      const serverPid = server.pid;
      const outputOffset = compilerOutput(compiler).length;

      writeAppFile(app.path, "src/pages/items/[id].tsx", typedRouteSource("after"));

      await waitForCompilerMessage(compiler, outputOffset, "Found 4 errors");
      expect(compiler.pid).toBe(compilerPid);
      expect(server.pid).toBe(serverPid);

      const recoveryOffset = compilerOutput(compiler).length;
      writeAppFile(app.path, "type-consumer.ts", typeConsumerSource("after"));

      await waitForCompilerMessage(compiler, recoveryOffset, "Found 0 errors");
      expect(compiler.pid).toBe(compilerPid);
      expect(server.pid).toBe(serverPid);
    } finally {
      compiler?.kill();
      server?.kill();
      app.cleanup();
    }
  },
  45_000
);
