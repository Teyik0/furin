import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDevFiles } from "../../../src/build/hydrate.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";

test("unchanged dev artifacts do not report another write", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "furin-dev-files-"));
  const outDir = join(projectRoot, ".furin");
  const log = spyOn(console, "log").mockImplementation(() => undefined);

  try {
    const options = {
      basePath: "",
      clientLogging: false,
      outDir,
      publicPath: "/_client/",
      rootLayout: join(projectRoot, "src/pages/root.tsx"),
      skipRouteTypes: false,
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
        skipRouteTypes: false,
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
