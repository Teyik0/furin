import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";

const { createBuildFingerprint } = await import("../../../src/adapter/bun.ts");

describe("createBuildFingerprint", () => {
  test("includes the native routes plugin source", async () => {
    const appDir = mkdtempSync(resolve(tmpdir(), "furin-fingerprint-routes-"));

    try {
      const rootPath = join(appDir, "root.tsx");
      writeFileSync(rootPath, "root");
      const root: RootLayout = {
        path: rootPath,
        route: { __type: "FURIN_ROUTE" },
      };
      const routesPluginPath = resolve(import.meta.dir, "../../../src/plugin/routes.ts");
      const routesPluginSource = await Bun.file(routesPluginPath).text();

      const fingerprint = await createBuildFingerprint("entry.js", [], [], root, null);

      expect(fingerprint).toContain(
        `${routesPluginPath.replaceAll("\\", "/")}:${routesPluginSource}`
      );
    } finally {
      rmSync(appDir, { force: true, recursive: true });
    }
  });

  test("orders route inputs without locale-sensitive collation", async () => {
    const appDir = mkdtempSync(resolve(tmpdir(), "furin-fingerprint-"));

    try {
      const rootPath = join(appDir, "root.tsx");
      const firstRoutePath = join(appDir, "é.tsx");
      const secondRoutePath = join(appDir, "z.tsx");
      writeFileSync(rootPath, "root");
      writeFileSync(firstRoutePath, "first");
      writeFileSync(secondRoutePath, "second");

      const routeDefinition = { __type: "FURIN_ROUTE" } satisfies RootLayout["route"];
      const root: RootLayout = {
        path: rootPath,
        route: routeDefinition,
      };
      const routes: ResolvedRoute[] = [
        {
          mode: "ssr",
          page: {
            __type: "FURIN_PAGE",
            _route: routeDefinition,
            component: () => null,
          },
          path: firstRoutePath,
          pattern: "/é",
          routeChain: [],
          segmentBoundaries: [],
        },
        {
          mode: "ssr",
          page: {
            __type: "FURIN_PAGE",
            _route: routeDefinition,
            component: () => null,
          },
          path: secondRoutePath,
          pattern: "/z",
          routeChain: [],
          segmentBoundaries: [],
        },
      ];

      const fingerprint = await createBuildFingerprint("entry.js", [], routes, root, null);
      const zRouteIndex = fingerprint.indexOf('"pattern":"/z"');
      const accentedRouteIndex = fingerprint.indexOf('"pattern":"/é"');

      expect(zRouteIndex).toBeGreaterThan(-1);
      expect(accentedRouteIndex).toBeGreaterThan(-1);
      expect(zRouteIndex).toBeLessThan(accentedRouteIndex);
    } finally {
      rmSync(appDir, { force: true, recursive: true });
    }
  });
});
