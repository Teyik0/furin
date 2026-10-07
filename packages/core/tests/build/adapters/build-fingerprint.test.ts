import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";

const { createBuildFingerprint } = await import("../../../src/adapter/runtime-build.ts");

describe("createBuildFingerprint", () => {
  test("changes when an externalized package's transitive server code changes", async () => {
    const appDir = mkdtempSync(resolve(tmpdir(), "furin-fingerprint-package-"));
    try {
      const packageDir = join(appDir, "node_modules/server-only-service");
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "server-only-service", version: "1.0.0", main: "index.js" }));
      writeFileSync(join(packageDir, "index.js"), 'module.exports = require("./data.js");');
      writeFileSync(join(packageDir, "data.js"), 'module.exports = "Before";');
      const rootPath = join(appDir, "root.tsx");
      const serverPath = join(appDir, "server.ts");
      writeFileSync(rootPath, "export default null;");
      writeFileSync(serverPath, 'import value from "server-only-service"; export default value;');
      const root: RootLayout = { path: rootPath, route: { __type: "FURIN_ROUTE" } };
      const first = await createBuildFingerprint("entry.js", [], [], root, serverPath, [], appDir);
      writeFileSync(join(packageDir, "data.js"), 'module.exports = "After";');
      const second = await createBuildFingerprint("entry.js", [], [], root, serverPath, [], appDir);
      expect(Bun.hash(first)).not.toBe(Bun.hash(second));
    } finally {
      rmSync(appDir, { force: true, recursive: true });
    }
  });
  test("is stable across checkout locations", async () => {
    const first = mkdtempSync(resolve(tmpdir(), "furin-fingerprint-first-"));
    const second = mkdtempSync(resolve(tmpdir(), "furin-fingerprint-second-"));
    try {
      const fingerprints = await Promise.all([first, second].map(async (appDir) => {
        const rootPath = join(appDir, "src/pages/root.tsx");
        mkdirSync(join(appDir, "src/pages"), { recursive: true });
        writeFileSync(rootPath, 'export { value as default } from "../data";');
        writeFileSync(join(appDir, "src/data.ts"), 'export const value = "identical root";');
        const packageDir = join(appDir, "node_modules/service");
        mkdirSync(packageDir, { recursive: true });
        writeFileSync(join(packageDir, "package.json"), '{"name":"service","main":"index.js"}');
        writeFileSync(join(packageDir, "index.js"), 'module.exports = "same server dependency";');
        writeFileSync(join(appDir, "server.ts"), 'import service from "service"; export default service;');
        writeFileSync(join(appDir, "bun.lock"), "identical lockfile");
        const root: RootLayout = { path: rootPath, route: { __type: "FURIN_ROUTE" } };
        return createBuildFingerprint("entry.js", [], [], root, join(appDir, "server.ts"), [], appDir);
      }));
      expect(fingerprints[0]).toBe(fingerprints[1]);
    } finally {
      rmSync(first, { force: true, recursive: true });
      rmSync(second, { force: true, recursive: true });
    }
  });

  test("includes the nearest workspace Bun lockfile", async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), "furin-fingerprint-lock-"));
    try {
      const appDir = join(workspace, "apps/site");
      mkdirSync(appDir, { recursive: true });
      const rootPath = join(appDir, "root.tsx");
      writeFileSync(rootPath, "export default null;");
      writeFileSync(join(workspace, "bun.lock"), "lock before");
      const root: RootLayout = { path: rootPath, route: { __type: "FURIN_ROUTE" } };
      const first = await createBuildFingerprint("entry.js", [], [], root, null, [], appDir);
      writeFileSync(join(workspace, "bun.lock"), "lock after");
      const second = await createBuildFingerprint("entry.js", [], [], root, null, [], appDir);
      expect(Bun.hash(first)).not.toBe(Bun.hash(second));
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("follows the require export condition used by server CommonJS imports", async () => {
    const appDir = mkdtempSync(resolve(tmpdir(), "furin-fingerprint-require-"));
    try {
      const packageDir = join(appDir, "node_modules/conditional-service");
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, "package.json"), JSON.stringify({
        name: "conditional-service",
        exports: { import: "./esm.js", require: "./cjs.js" },
      }));
      writeFileSync(join(packageDir, "esm.js"), 'export default "ESM";');
      writeFileSync(join(packageDir, "cjs.js"), 'module.exports = "Before";');
      const rootPath = join(appDir, "root.tsx");
      const serverPath = join(appDir, "server.cjs");
      writeFileSync(rootPath, "export default null;");
      writeFileSync(serverPath, 'module.exports = require("conditional-service");');
      const root: RootLayout = { path: rootPath, route: { __type: "FURIN_ROUTE" } };
      const first = await createBuildFingerprint("entry.js", [], [], root, serverPath, [], appDir);
      writeFileSync(join(packageDir, "cjs.js"), 'module.exports = "After";');
      const second = await createBuildFingerprint("entry.js", [], [], root, serverPath, [], appDir);
      expect(Bun.hash(first)).not.toBe(Bun.hash(second));
      expect(second).toContain("dependency/conditional-service/cjs.js:");
      expect(second).not.toContain("dependency/conditional-service/esm.js:");
    } finally {
      rmSync(appDir, { force: true, recursive: true });
    }
  });

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

      const fingerprint = await createBuildFingerprint("entry.js", [], [], root, null, [], appDir);

      expect(fingerprint).toContain(
        `furin/src/plugin/routes.ts:${routesPluginSource}`
      );
    } finally {
      rmSync(appDir, { force: true, recursive: true });
    }
  });

  test("includes inferred requestLoader field names", async () => {
    const appDir = mkdtempSync(resolve(tmpdir(), "furin-fingerprint-request-"));
    try {
      const rootPath = join(appDir, "root.tsx");
      const pagePath = join(appDir, "account.tsx");
      writeFileSync(rootPath, "root");
      writeFileSync(pagePath, "account");
      const routeDefinition = { __type: "FURIN_ROUTE" } satisfies RootLayout["route"];
      const root: RootLayout = { path: rootPath, route: routeDefinition };
      const route: ResolvedRoute = {
        mode: "ssr",
        page: { __type: "FURIN_PAGE", _route: routeDefinition, component: () => null },
        path: pagePath,
        pattern: "/account",
        requestKeys: ["user"],
        routeChain: [],
        segmentBoundaries: [],
      };

      const first = await createBuildFingerprint("entry.js", [], [route], root, null, [], appDir);
      const second = await createBuildFingerprint(
        "entry.js", [], [{ ...route, requestKeys: ["permissions"] }], root, null, [], appDir
      );
      expect(first).not.toBe(second);
      const byLoader = await createBuildFingerprint(
        "entry.js",
        [],
        [{ ...route, requestKeysByLoader: [["user"]] }],
        root,
        null,
        [],
        appDir
      );
      expect(first).not.toBe(byLoader);
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

      const fingerprint = await createBuildFingerprint("entry.js", [], routes, root, null, [], appDir);
      const zRouteIndex = fingerprint.indexOf('"pattern":"/z"');
      const accentedRouteIndex = fingerprint.indexOf('"pattern":"/é"');

      expect(zRouteIndex).toBeGreaterThan(-1);
      expect(accentedRouteIndex).toBeGreaterThan(-1);
      expect(zRouteIndex).toBeLessThan(accentedRouteIndex);
    } finally {
      rmSync(appDir, { force: true, recursive: true });
    }
  });

  test("includes server-only route modules", async () => {
    const appDir = mkdtempSync(resolve(tmpdir(), "furin-fingerprint-layout-"));

    try {
      const rootPath = join(appDir, "root.tsx");
      const layoutPath = join(appDir, "_route.tsx");
      writeFileSync(rootPath, "root");
      writeFileSync(layoutPath, 'export const loader = () => "server-only layout loader";');
      const root: RootLayout = {
        path: rootPath,
        route: { __type: "FURIN_ROUTE" },
      };

      const fingerprint = await createBuildFingerprint(
        "entry.js",
        [],
        [],
        root,
        null,
        [layoutPath],
        appDir
      );

      expect(fingerprint).toContain("server-only layout loader");
    } finally {
      rmSync(appDir, { force: true, recursive: true });
    }
  });

  test("changes when a transitive server dependency changes without changing the entry or client", async () => {
    const appDir = mkdtempSync(resolve(tmpdir(), "furin-fingerprint-dependency-"));
    try {
      const rootPath = join(appDir, "root.tsx");
      const serverPath = join(appDir, "server.ts");
      const servicePath = join(appDir, "service.ts");
      const dependencyPath = join(appDir, "data.ts");
      writeFileSync(rootPath, "export default null;");
      writeFileSync(serverPath, 'export { load } from "./service";');
      writeFileSync(servicePath, 'import { value } from "./data"; export const load = () => value;');
      writeFileSync(dependencyPath, 'export const value = "Before";');
      const root: RootLayout = { path: rootPath, route: { __type: "FURIN_ROUTE" } };
      const first = await createBuildFingerprint("entry.js", [], [], root, serverPath, [], appDir);
      writeFileSync(dependencyPath, 'export const value = "After";');
      const second = await createBuildFingerprint("entry.js", [], [], root, serverPath, [], appDir);

      expect(Bun.hash(first)).not.toBe(Bun.hash(second));
      expect(second.includes('app/data.ts:export const value = "After";')).toBe(true);
    } finally {
      rmSync(appDir, { force: true, recursive: true });
    }
  });

  test("accepts plugin-owned virtual imports while fingerprinting filesystem dependencies", async () => {
    const appDir = mkdtempSync(resolve(tmpdir(), "furin-fingerprint-virtual-"));
    try {
      const rootPath = join(appDir, "root.tsx");
      writeFileSync(
        rootPath,
        'import virtual from "virtual:content"; import { value } from "./data"; export default `${virtual}:${value}`;'
      );
      writeFileSync(join(appDir, "data.ts"), 'export const value = "local data";');
      const build = await Bun.build({
        entrypoints: [rootPath],
        plugins: [{
          name: "virtual-content",
          setup(builder) {
            builder.onResolve({ filter: /^virtual:/ }, ({ path }) => ({ path, namespace: "virtual" }));
            builder.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({
              contents: 'export default "plugin content";',
              loader: "js",
            }));
          },
        }],
      });
      expect(build.success).toBe(true);
      const root: RootLayout = { path: rootPath, route: { __type: "FURIN_ROUTE" } };
      const fingerprint = await createBuildFingerprint("entry.js", [], [], root, null, [], appDir);
      expect(fingerprint).toContain('app/data.ts:export const value = "local data";');
    } finally {
      rmSync(appDir, { force: true, recursive: true });
    }
  });

  test("follows application aliases and literal dynamic imports without recursing through cycles", async () => {
    const appDir = mkdtempSync(resolve(tmpdir(), "furin-fingerprint-alias-"));
    try {
      mkdirSync(join(appDir, "src/data"), { recursive: true });
      const rootPath = join(appDir, "root.tsx");
      const detailsPath = join(appDir, "src/data/details.ts");
      writeFileSync(join(appDir, "tsconfig.json"), JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@data/*": ["src/data/*"] } },
      }));
      writeFileSync(rootPath, 'export { load as default } from "@data/service";');
      writeFileSync(
        join(appDir, "src/data/service.ts"),
        'export const value = "Before"; export const load = () => import("./details");'
      );
      writeFileSync(detailsPath, 'import { value } from "./service"; export const result = value;');
      const root: RootLayout = { path: rootPath, route: { __type: "FURIN_ROUTE" } };
      const first = await createBuildFingerprint("entry.js", [], [], root, null, [], appDir);
      writeFileSync(detailsPath, 'import { value } from "./service"; export const result = `${value}:After`;');
      const second = await createBuildFingerprint("entry.js", [], [], root, null, [], appDir);

      expect(Bun.hash(first)).not.toBe(Bun.hash(second));
      expect(second.includes("app/src/data/details.ts:")).toBe(true);
      expect(second.includes("app/src/data/service.ts:")).toBe(true);
    } finally {
      rmSync(appDir, { force: true, recursive: true });
    }
  });
});
