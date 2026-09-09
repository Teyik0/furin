import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeRouteTypes } from "../../src/build/route-types.ts";
import type { ResolvedRoute } from "../../src/server/router/types.ts";

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
    temporaryDirectory = mkdtempSync("/tmp/furin-route-types-");
    mkdirSync(join(temporaryDirectory, "src/pages/boards"), { recursive: true });
  });

  afterAll(() => {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  });

  test("emits only the Elysia-derived RouteMap contract", () => {
    writeRouteTypes(
      [route("/boards/:id", join(temporaryDirectory, "src/pages/boards/[id].tsx"))],
      temporaryDirectory
    );

    const content = readFileSync(join(temporaryDirectory, "furin-env.d.ts"), "utf8");
    expect(content).toContain('declare module "@teyik0/furin/routes"');
    expect(content).toContain("interface RouteMap");
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
