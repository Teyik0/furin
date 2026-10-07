import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRouteTypes } from "../../src/build/route-types.ts";
import type { ResolvedRoute } from "../../src/server/router/types.ts";
import { routeMapDeclaration } from "../../src/shared/route-map.ts";
import { startProcess } from "../support/process.ts";

function route(pattern: string, path: string, tags?: string[]): ResolvedRoute {
  return {
    mode: "ssr",
    page: {
      __type: "FURIN_PAGE",
      _route: { __type: "FURIN_ROUTE" },
      component: () => null,
    },
    path,
    pattern,
    routeChain: [],
    segmentBoundaries: [],
    ...(tags ? { tags } : {}),
  } as unknown as ResolvedRoute;
}

describe("writeRouteTypes", () => {
  let temporaryDirectory: string;

  beforeAll(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "furin-route-types-"));
    mkdirSync(join(temporaryDirectory, "src/pages/boards"), { recursive: true });
  });

  afterAll(() => {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  });

  test("dynamic and catch-all sibling routes retain both types in a valid TypeScript contract", async () => {
    const directory = join(temporaryDirectory, "overlap");
    mkdirSync(directory);
    writeFileSync(join(directory, "one.ts"), 'export const route = { kind: "dynamic" } as const;');
    writeFileSync(join(directory, "two.ts"), 'export const route = { kind: "catchall" } as const;');
    writeFileSync(
      join(directory, "routes.d.ts"),
      routeMapDeclaration([
        { pattern: "/blog/:id", importSpecifier: "./one" },
        { pattern: "/blog/*", importSpecifier: "./two" },
      ])
    );
    writeFileSync(
      join(directory, "consumer.ts"),
      `
      import type { RouteMap } from "@teyik0/furin/routes";
      const dynamic: RouteMap["/blog/example"]["kind"] = "dynamic";
      const catchall: RouteMap["/blog/example"]["kind"] = "catchall";
    `
    );
    const config = join(directory, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          strict: true,
          skipLibCheck: false,
          types: [],
          target: "ESNext",
        },
        files: ["routes.d.ts", "consumer.ts"],
      })
    );
    const compiler = startProcess(
      [
        process.execPath,
        join(import.meta.dir, "../../node_modules/typescript/lib/tsc.js"),
        "--project",
        config,
      ],
      { cwd: directory }
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exitCode = await Promise.race([
        compiler.exitCode,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            compiler.kill();
            reject(
              new Error(
                `TypeScript contract check timed out.\n${compiler.getStdout()}\n${compiler.getStderr()}`
              )
            );
          }, 12_000);
        }),
      ]);
      expect(compiler.getStdout() + compiler.getStderr()).toBe("");
      expect(exitCode).toBe(0);
    } finally {
      clearTimeout(timer);
      compiler.kill();
      await compiler.exitCode;
    }
  });

  test("emits only the Elysia-derived RouteMap contract", () => {
    writeRouteTypes(
      [route("/boards/:id", join(temporaryDirectory, "src/pages/boards/[id].tsx"))],
      temporaryDirectory
    );

    const content = readFileSync(join(temporaryDirectory, "furin-env.d.ts"), "utf8");
    expect(content).toContain('declare module "@teyik0/furin/routes"');
    expect(content).toContain("interface RouteMap");
    expect(content).toContain("interface RoutePatternMap");
    expect(content).toContain('"/boards/:id": typeof import("./src/pages/boards/[id]").route;');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts generated TypeScript syntax
    expect(content).toContain("[path: `/boards/${string}`]");
    expect(content).toContain('typeof import("./src/pages/boards/[id]").route');
    expect(content).not.toContain("RouteManifest");
    expect(content).not.toContain("searchInput");
  });

  test("keeps an empty RouteMap valid", () => {
    writeRouteTypes([], temporaryDirectory);

    const content = readFileSync(join(temporaryDirectory, "furin-env.d.ts"), "utf8");
    expect(content).toContain("interface RouteMap {\n\n  }");
  });

  test("does not rewrite identical content", async () => {
    const routes = [route("/", join(temporaryDirectory, "src/pages/index.tsx"))];
    const outputPath = join(temporaryDirectory, "furin-env.d.ts");
    writeRouteTypes(routes, temporaryDirectory);
    const firstTimestamp = Bun.file(outputPath).lastModified;
    await Bun.sleep(5);

    writeRouteTypes(routes, temporaryDirectory);

    expect(Bun.file(outputPath).lastModified).toBe(firstTimestamp);
  });

  test("emits static route properties before dynamic route properties", () => {
    writeRouteTypes(
      [
        route("/weather/:city", join(temporaryDirectory, "src/pages/weather/[city].tsx")),
        route("/weather/search", join(temporaryDirectory, "src/pages/weather/search.tsx")),
      ],
      temporaryDirectory
    );

    const content = readFileSync(join(temporaryDirectory, "furin-env.d.ts"), "utf8");
    expect(content.indexOf('"/weather/search"')).toBeLessThan(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts generated TypeScript syntax
      content.indexOf("[path: `/weather/${string}`]")
    );
  });

  test("emits sorted, deduplicated cache tags", () => {
    writeRouteTypes(
      [
        route("/", join(temporaryDirectory, "src/pages/index.tsx"), ["boards", "alpha"]),
        route("/posts", join(temporaryDirectory, "src/pages/posts.tsx"), ["boards"]),
      ],
      temporaryDirectory
    );

    const content = readFileSync(join(temporaryDirectory, "furin-env.d.ts"), "utf8");
    expect(content).toContain("alpha: 'alpha';");
    expect(content).toContain("boards: 'boards';");
    expect(content.split("boards: 'boards';")).toHaveLength(2);
    expect(content.indexOf("alpha: 'alpha';")).toBeLessThan(content.indexOf("boards: 'boards';"));
  });
});
