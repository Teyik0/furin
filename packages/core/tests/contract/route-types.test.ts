import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRouteTypes } from "../../src/build/route-types.ts";
import type { ResolvedRoute } from "../../src/server/router/types.ts";
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

async function typecheck(directory: string, files: string[]): Promise<string> {
  const config = join(directory, "tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        module: "Preserve",
        moduleResolution: "bundler",
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        target: "ESNext",
        types: [],
      },
      files,
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
    await Promise.race([
      compiler.exitCode,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          compiler.kill();
          reject(new Error("TypeScript contract check timed out."));
        }, 12_000);
      }),
    ]);
    return compiler.getStdout() + compiler.getStderr();
  } finally {
    clearTimeout(timer);
    compiler.kill();
    await compiler.exitCode;
  }
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

  test("generated weather declarations type-check with skipLibCheck: false", async () => {
    const directory = join(temporaryDirectory, "weather");
    const furinPackage = join(directory, "node_modules/@teyik0/furin");
    mkdirSync(join(directory, "src/pages/weather"), { recursive: true });
    mkdirSync(furinPackage, { recursive: true });
    writeFileSync(
      join(furinPackage, "package.json"),
      JSON.stringify({
        exports: { "./env": { types: "./env.d.ts" }, "./routes": { types: "./routes.d.ts" } },
        name: "@teyik0/furin",
      })
    );
    writeFileSync(join(furinPackage, "env.d.ts"), "export {};\n");
    writeFileSync(
      join(furinPackage, "routes.d.ts"),
      readFileSync(join(import.meta.dir, "../../src/routes.ts"), "utf8")
    );
    for (const [file, kind] of [
      ["root", "root"],
      ["index", "home"],
      ["weather/[city]", "city"],
      ["weather/search", "search"],
      ["blog/[id]", "post"],
      ["blog/[...rest]", "archive"],
    ] as const) {
      mkdirSync(join(directory, "src/pages", file, ".."), { recursive: true });
      writeFileSync(
        join(directory, "src/pages", `${file}.ts`),
        `export const route = { kind: "${kind}" } as const;\n`
      );
    }
    writeRouteTypes(
      [
        route("/", join(directory, "src/pages/index.tsx")),
        route("/weather/:city", join(directory, "src/pages/weather/[city].tsx")),
        route("/weather/search", join(directory, "src/pages/weather/search.tsx")),
        route("/blog/:id", join(directory, "src/pages/blog/[id].tsx")),
        route("/blog/*", join(directory, "src/pages/blog/[...rest].tsx")),
      ],
      directory,
      [{ pagesDir: join(directory, "src/pages"), prefix: "" }]
    );
    writeFileSync(
      join(directory, "consumer.ts"),
      `import type { FileRoutes, RouteMap } from "@teyik0/furin/routes";
const city: RouteMap["/weather/:city"]["kind"] = "city";
const search: RouteMap["/weather/search"]["kind"] = "search";
const archive: RouteMap["/blog/*"]["kind"] = "archive";
const parent: FileRoutes["/weather/[city]"]["parent"]["kind"] = "root";
const rest: FileRoutes["/blog/[...rest]"]["pathParams"] = { "*": "a/b" };
export { archive, city, parent, rest, search };
`
    );

    expect(await typecheck(directory, ["furin-env.d.ts", "consumer.ts"])).toBe("");
  });

  test("keys the generated RouteMap by exact route patterns", () => {
    writeRouteTypes(
      [route("/boards/:id", join(temporaryDirectory, "src/pages/boards/[id].tsx"))],
      temporaryDirectory
    );

    const content = readFileSync(join(temporaryDirectory, "furin-env.d.ts"), "utf8");
    expect(content).toContain('declare module "@teyik0/furin/routes"');
    expect(content).toContain('    "/boards/:id": typeof import("./src/pages/boards/[id]").route;');
    expect(content).not.toContain("[path:");
    expect(content).not.toContain("RoutePatternMap");
    expect(content).not.toContain("RouteManifest");
  });

  test("declares FileRoutes from the pages tree, keyed by file id, without importing routes", () => {
    const directory = join(temporaryDirectory, "file-routes");
    const pagesDir = join(directory, "src/pages");
    for (const file of [
      "root.tsx",
      "index.tsx",
      "board/_route.tsx",
      "board/[boardId]/index.tsx",
      "board/[boardId]/card/_route.tsx",
      "board/[boardId]/card/[cardId].tsx",
      "(marketing)/_route.tsx",
      "(marketing)/about.tsx",
      "docs/[...slug].tsx",
      "docs/_components/toc.tsx",
      "not-found.tsx",
    ]) {
      mkdirSync(join(pagesDir, file, ".."), { recursive: true });
      // Throws if imported: typegen must read the tree, not the modules.
      writeFileSync(join(pagesDir, file), 'throw new Error("imported");\n');
    }

    writeRouteTypes([], directory, [{ pagesDir, prefix: "" }]);

    const content = readFileSync(join(directory, "furin-env.d.ts"), "utf8");
    expect(content).toContain(`declare module "@teyik0/furin/routes" {
  interface FileRoutes {
    "/": {
      kind: "page";
      pattern: "/";
      parent: typeof import("./src/pages/root").route;
      pathParams: {};
    };
    "/(marketing)/_route": {
      kind: "layout";
      pattern: "/";
      parent: typeof import("./src/pages/root").route;
      pathParams: {};
    };
    "/(marketing)/about": {
      kind: "page";
      pattern: "/about";
      parent: typeof import("./src/pages/(marketing)/_route").route;
      pathParams: {};
    };
    "/board/[boardId]": {
      kind: "page";
      pattern: "/board/:boardId";
      parent: typeof import("./src/pages/board/_route").route;
      pathParams: { boardId: string };
    };
    "/board/[boardId]/card/[cardId]": {
      kind: "page";
      pattern: "/board/:boardId/card/:cardId";
      parent: typeof import("./src/pages/board/[boardId]/card/_route").route;
      pathParams: { boardId: string; cardId: string };
    };
    "/board/[boardId]/card/_route": {
      kind: "layout";
      pattern: "/board/:boardId/card";
      parent: typeof import("./src/pages/board/_route").route;
      pathParams: { boardId: string };
    };
    "/board/_route": {
      kind: "layout";
      pattern: "/board";
      parent: typeof import("./src/pages/root").route;
      pathParams: {};
    };
    "/docs/[...slug]": {
      kind: "page";
      pattern: "/docs/*";
      parent: typeof import("./src/pages/root").route;
      pathParams: { "*": string };
    };
  }
}`);
  });

  test("declares FileRoutes for every mounted app, keyed by its prefix and file id", () => {
    const directory = join(temporaryDirectory, "file-routes-apps");
    for (const file of [
      "pages/root.tsx",
      "pages/index.tsx",
      "admin/root.tsx",
      "admin/index.tsx",
      "admin/users/_route.tsx",
      "admin/users/[id].tsx",
    ]) {
      mkdirSync(join(directory, "src", file, ".."), { recursive: true });
      writeFileSync(join(directory, "src", file), 'throw new Error("imported");\n');
    }

    writeRouteTypes([], directory, [
      { pagesDir: join(directory, "src/pages"), prefix: "" },
      { pagesDir: join(directory, "src/admin"), prefix: "/admin" },
    ]);

    const content = readFileSync(join(directory, "furin-env.d.ts"), "utf8");
    expect(content).toContain(`  interface FileRoutes {
    "/": {
      kind: "page";
      pattern: "/";
      parent: typeof import("./src/pages/root").route;
      pathParams: {};
    };
    "/admin": {
      kind: "page";
      pattern: "/admin";
      parent: typeof import("./src/admin/root").route;
      pathParams: {};
    };
    "/admin/users/[id]": {
      kind: "page";
      pattern: "/admin/users/:id";
      parent: typeof import("./src/admin/users/_route").route;
      pathParams: { id: string };
    };
    "/admin/users/_route": {
      kind: "layout";
      pattern: "/admin/users";
      parent: typeof import("./src/admin/root").route;
      pathParams: {};
    };
  }`);
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

  test("writes byte-identical output whatever the discovery order", () => {
    const routes = [
      route("/weather/search", join(temporaryDirectory, "src/pages/weather/search.tsx"), ["b"]),
      route("/", join(temporaryDirectory, "src/pages/index.tsx")),
      route("/weather/:city", join(temporaryDirectory, "src/pages/weather/[city].tsx"), ["a"]),
      route("/Weather", join(temporaryDirectory, "src/pages/Weather.tsx")),
      route("/weather/10", join(temporaryDirectory, "src/pages/weather/10.tsx")),
      route("/weather/9", join(temporaryDirectory, "src/pages/weather/9.tsx")),
    ];
    const outputPath = join(temporaryDirectory, "furin-env.d.ts");

    writeRouteTypes(routes, temporaryDirectory);
    const forward = readFileSync(outputPath, "utf8");
    writeRouteTypes(routes.toReversed(), temporaryDirectory);
    const reversed = readFileSync(outputPath, "utf8");

    expect(reversed).toBe(forward);
    const order = ["/", "/Weather", "/weather/10", "/weather/9", "/weather/:city"];
    const positions = order.map((pattern) => forward.indexOf(`"${pattern}"`));
    expect(positions).toEqual(positions.toSorted((left, right) => left - right));
    expect(forward.indexOf('"/weather/:city"')).toBeLessThan(forward.indexOf('"/weather/search"'));
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
