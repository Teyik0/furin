import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDevFiles } from "../../../src/build/hydrate.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";

test("unchanged dev artifacts do not report another write", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "furin-dev-files-"));
  mkdirSync(join(projectRoot, "src/pages"), { recursive: true });
  const outDir = join(projectRoot, ".furin");
  const log = spyOn(console, "log").mockImplementation(() => undefined);

  try {
    const options = {
      basePath: "",
      clientLogging: false,
      outDir,
      publicPath: "/_client/",
      rootLayout: join(projectRoot, "src/pages/root.tsx"),
      prefix: "",
    };
    writeDevFiles([], options, projectRoot);
    writeDevFiles([], options, projectRoot);

    expect(log).toHaveBeenCalledTimes(1);
  } finally {
    log.mockRestore();
    rmSync(projectRoot, { force: true, recursive: true });
  }
});

test("an unloadable development route is included in generated route types", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "furin-dev-files-"));
  mkdirSync(join(projectRoot, "src/pages"), { recursive: true });
  const route = {
    mode: "ssr",
    page: { __type: "FURIN_PAGE", _route: { __type: "FURIN_ROUTE" }, component: () => null },
    path: join(projectRoot, "src/pages/cards.tsx"),
    pattern: "/cards",
    routeChain: [],
    segmentBoundaries: [],
  } as unknown as ResolvedRoute;

  try {
    const typesPath = join(projectRoot, "furin-env.d.ts");
    writeDevFiles(
      [route],
      {
        basePath: "",
        clientLogging: false,
        outDir: join(projectRoot, ".furin"),
        publicPath: "/_client/",
        rootLayout: join(projectRoot, "src/pages/root.tsx"),
        prefix: "",
      },
      projectRoot
    );

    expect(readFileSync(typesPath, "utf8")).toContain(
      '"/cards": typeof import("./src/pages/cards").route;'
    );
  } finally {
    rmSync(projectRoot, { force: true, recursive: true });
  }
});

test("each mounted app adds its route files to the one furin-env.d.ts", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "furin-dev-files-"));
  for (const file of ["src/pages/root.tsx", "src/pages/cards.tsx", "src/admin/root.tsx"]) {
    mkdirSync(join(projectRoot, file, ".."), { recursive: true });
    writeFileSync(join(projectRoot, file), "");
  }
  writeFileSync(join(projectRoot, "src/admin/users.tsx"), "");
  const route = {
    mode: "ssr",
    page: { __type: "FURIN_PAGE", _route: { __type: "FURIN_ROUTE" }, component: () => null },
    path: join(projectRoot, "src/pages/cards.tsx"),
    pattern: "/cards",
    routeChain: [],
    segmentBoundaries: [],
  } as unknown as ResolvedRoute;
  const app = (pagesDir: string, prefix: string) => ({
    basePath: prefix,
    clientLogging: false,
    outDir: join(projectRoot, ".furin", prefix),
    prefix,
    publicPath: `${prefix}/_client/`,
    rootLayout: join(projectRoot, pagesDir, "root.tsx"),
  });
  const log = spyOn(console, "log").mockImplementation(() => undefined);

  try {
    writeDevFiles([route], app("src/pages", ""), projectRoot);
    writeDevFiles([], app("src/admin", "/admin"), projectRoot);

    const types = readFileSync(join(projectRoot, "furin-env.d.ts"), "utf8");
    expect(types).toContain('"/cards": typeof import("./src/pages/cards").route;');
    expect(types).toContain('    "/cards": {\n      kind: "page";');
    expect(types).toContain('    "/admin/users": {\n      kind: "page";');
  } finally {
    log.mockRestore();
    rmSync(projectRoot, { force: true, recursive: true });
  }
});
