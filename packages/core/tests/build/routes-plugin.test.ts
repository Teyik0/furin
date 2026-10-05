import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  composableRouteModuleSpecifier,
  createRoutesPlugin,
  materializedRouteModuleSource,
  routeModuleSpecifier,
  type RouteInstanceSpec,
} from "../../src/plugin/routes.ts";
import { routeMapDeclaration } from "../../src/shared/route-map.ts";

const FIXTURES = join(import.meta.dir, "../fixtures/routes-v2");

describe("furin/routes server plugin", () => {
  test("rejects conflicting dynamic URLs across route groups", async () => {
    const pagesDir = mkdtempSync(join(import.meta.dir, ".tmp-routes-group-conflict-"));
    try {
      for (const [group, parameter] of [["(admin)", "id"], ["(marketing)", "slug"]] as const) {
        const directory = join(pagesDir, group, "users");
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, `[${parameter}].ts`), "export const route = {};");
      }

      await expect(materializedRouteModuleSource({ pagesDir, prefix: "" })).rejects.toThrow(
        '[furin] Duplicate route pattern "/users/:param" from "(admin)/users/[id].ts" and "(marketing)/users/[slug].ts".'
      );
    } finally {
      rmSync(pagesDir, { force: true, recursive: true });
    }
  });

  test("serves grouped routes with isolated layouts and nested groups", async () => {
    const instance = { pagesDir: join(FIXTURES, "../pages/route-groups"), prefix: "" };
    const tempDir = mkdtempSync(join(import.meta.dir, ".tmp-routes-groups-"));

    try {
      const entryPath = join(tempDir, "entry.ts");
      writeFileSync(
        entryPath,
        `export { furinApp } from ${JSON.stringify(routeModuleSpecifier(instance))};\n`
      );
      const result = await Bun.build({
        entrypoints: [entryPath],
        naming: "built.js",
        outdir: tempDir,
        plugins: [createRoutesPlugin({ instances: [instance], target: "server" })],
        target: "bun",
      });
      expect(result.success).toBe(true);
      const output = result.outputs.find((artifact) => artifact.kind === "entry-point");
      if (!output) {
        throw new Error("Expected a bundled entry point");
      }
      const built = (await import(`${output.path}?t=${Date.now()}`)) as {
        furinApp: { handle(request: Request): Promise<Response> };
      };

      const admin = await built.furinApp.handle(new Request("http://localhost/users/42"));
      expect(admin.status).toBe(200);
      expect(await admin.json()).toEqual({ group: "admin", id: "42" });
      const marketing = await built.furinApp.handle(new Request("http://localhost/"));
      expect(marketing.status).toBe(200);
      expect(await marketing.json()).toEqual({ group: "marketing" });
      expect(
        (await built.furinApp.handle(new Request("http://localhost/(admin)/users/42"))).status
      ).toBe(404);

      const clientEntry = join(tempDir, "client.ts");
      writeFileSync(clientEntry, 'export { routes } from "furin/routes";\n');
      const clientBuild = await Bun.build({
        entrypoints: [clientEntry],
        outdir: join(tempDir, "client"),
        plugins: [createRoutesPlugin({ instances: [instance], target: "client" })],
        target: "browser",
      });
      expect(clientBuild.success).toBe(true);
      const clientOutput = clientBuild.outputs.find((artifact) => artifact.kind === "entry-point");
      if (!clientOutput) {
        throw new Error("Expected a bundled client entry point");
      }
      const client = (await import(`${clientOutput.path}?t=${Date.now()}`)) as {
        routes: Array<{ pattern: string }>;
      };
      expect(client.routes.map((route) => route.pattern)).toEqual(["/", "/users/:id"]);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  test("keeps generated route bindings unique for separator-like paths", async () => {
    const instance = { pagesDir: join(FIXTURES, "colliding-paths"), prefix: "" };
    const tempDir = mkdtempSync(join(import.meta.dir, ".tmp-routes-bindings-"));
    const entryPath = join(tempDir, "entry.ts");

    try {
      writeFileSync(
        entryPath,
        `export { furinApp } from ${JSON.stringify(routeModuleSpecifier(instance))};\n`
      );
      const result = await Bun.build({
        entrypoints: [entryPath],
        naming: "built.js",
        outdir: tempDir,
        plugins: [createRoutesPlugin({ instances: [instance], target: "server" })],
        target: "bun",
      });
      expect(result.success).toBe(true);
      const output = result.outputs.find((artifact) => artifact.kind === "entry-point");
      if (!output) {
        throw new Error("Expected a bundled entry point");
      }
      const built = (await import(`${output.path}?t=${Date.now()}`)) as {
        furinApp: { handle(request: Request): Promise<Response> };
      };

      const [hyphen, nested] = await Promise.all([
        built.furinApp.handle(new Request("http://localhost/foo-bar")),
        built.furinApp.handle(new Request("http://localhost/foo/bar")),
      ]);

      expect(await hyphen.text()).toBe("hyphen");
      expect(await nested.text()).toBe("nested");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  test("preserves catch-all pages as Elysia wildcards", async () => {
    const instance = { pagesDir: join(FIXTURES, "catch-all"), prefix: "" };
    const tempDir = mkdtempSync(join(import.meta.dir, ".tmp-routes-catch-all-"));
    const entryPath = join(tempDir, "entry.ts");

    try {
      writeFileSync(
        entryPath,
        `export { furinApp } from ${JSON.stringify(routeModuleSpecifier(instance))};
export { furinApp as composableApp } from ${JSON.stringify(composableRouteModuleSpecifier(instance))};\n`
      );
      const result = await Bun.build({
        entrypoints: [entryPath],
        naming: "built.js",
        outdir: tempDir,
        plugins: [createRoutesPlugin({ instances: [instance], target: "server" })],
        target: "bun",
      });
      expect(result.success).toBe(true);
      const output = result.outputs.find((artifact) => artifact.kind === "entry-point");
      if (!output) {
        throw new Error("Expected a bundled entry point");
      }
      const built = (await import(`${output.path}?t=${Date.now()}`)) as {
        furinApp: { handle(request: Request): Promise<Response> };
        composableApp: { handle(request: Request): Promise<Response> };
      };

      const response = await built.furinApp.handle(
        new Request("http://localhost/docs/guides/routing")
      );
      if (response.status !== 200) {
        throw new Error(await response.text());
      }

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ catchAllPath: "guides/routing" });

      const rootResponse = await built.furinApp.handle(
        new Request("http://localhost/other/page")
      );
      expect(rootResponse.status).toBe(200);
      expect(await rootResponse.json()).toEqual({ rootCatchAllPath: "other/page" });
      expect(
        (await built.composableApp.handle(new Request("http://localhost/other/page"))).status
      ).toBe(404);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  test("resolves one isolated Elysia app per mounted instance", async () => {
    const rootInstance = { pagesDir: join(FIXTURES, "root"), prefix: "" };
    const adminInstance = { pagesDir: join(FIXTURES, "admin"), prefix: "/admin" };
    const instances = [rootInstance, adminInstance] satisfies RouteInstanceSpec[];
    const tempDir = mkdtempSync(join(import.meta.dir, ".tmp-routes-plugin-"));
    const entryPath = join(tempDir, "entry.ts");

    try {
      writeFileSync(
        entryPath,
        `import { furinApp as rootApp } from ${JSON.stringify(routeModuleSpecifier(rootInstance))};
import { furinApp as adminApp } from ${JSON.stringify(routeModuleSpecifier(adminInstance))};
export { adminApp, rootApp };
`
      );

      const result = await Bun.build({
        entrypoints: [entryPath],
        naming: "built.js",
        outdir: tempDir,
        plugins: [createRoutesPlugin({ instances, target: "server" })],
        target: "bun",
      });
      expect(result.success).toBe(true);
      const output = result.outputs.find((artifact) => artifact.kind === "entry-point");
      if (!output) {
        throw new Error("Expected a bundled entry point");
      }

      const built = (await import(`${output.path}?t=${Date.now()}`)) as {
        adminApp: { handle(request: Request): Promise<Response> };
        rootApp: { handle(request: Request): Promise<Response> };
      };
      expect(await (await built.rootApp.handle(new Request("http://localhost/"))).json()).toEqual({
        home: true,
        root: true,
      });
      expect(await (await built.adminApp.handle(new Request("http://localhost/"))).text()).toBe(
        "admin"
      );
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  test("composes nested layouts above their dynamic children", async () => {
    const instance = { pagesDir: join(FIXTURES, "root"), prefix: "" };
    const tempDir = mkdtempSync(join(import.meta.dir, ".tmp-routes-layout-"));
    const entryPath = join(tempDir, "entry.ts");

    try {
      writeFileSync(
        entryPath,
        `export { furinApp } from ${JSON.stringify(routeModuleSpecifier(instance))};\n`
      );
      const result = await Bun.build({
        entrypoints: [entryPath],
        naming: "built.js",
        outdir: tempDir,
        plugins: [createRoutesPlugin({ instances: [instance], target: "server" })],
        target: "bun",
      });
      expect(result.success).toBe(true);
      const output = result.outputs.find((artifact) => artifact.kind === "entry-point");
      if (!output) {
        throw new Error("Expected a bundled entry point");
      }
      const built = (await import(`${output.path}?t=${Date.now()}`)) as {
        furinApp: { handle(request: Request): Promise<Response> };
      };

      const response = await built.furinApp.handle(new Request("http://localhost/boards/42"));
      if (response.status !== 200) {
        throw new Error(await response.text());
      }
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ board: "42", user: "teyik" });
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  test("rejects dynamic paths without a matching params schema", async () => {
    const instance = { pagesDir: join(FIXTURES, "bad"), prefix: "" };
    const tempDir = mkdtempSync(join(import.meta.dir, ".tmp-routes-drift-"));
    const entryPath = join(tempDir, "entry.ts");

    try {
      writeFileSync(
        entryPath,
        `export { furinApp } from ${JSON.stringify(routeModuleSpecifier(instance))};\n`
      );
      await expect(
        Bun.build({
          entrypoints: [entryPath],
          outdir: tempDir,
          plugins: [createRoutesPlugin({ instances: [instance], target: "server" })],
          target: "bun",
        })
      ).rejects.toThrow("Bundle failed");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  test("ignores underscore-prefixed files and directories", async () => {
    const instance = { pagesDir: join(FIXTURES, "underscore"), prefix: "" };
    const tempDir = mkdtempSync(join(import.meta.dir, ".tmp-routes-underscore-"));
    const entryPath = join(tempDir, "entry.ts");

    try {
      writeFileSync(
        entryPath,
        `export { furinApp } from ${JSON.stringify(routeModuleSpecifier(instance))};\n`
      );
      const result = await Bun.build({
        entrypoints: [entryPath],
        naming: "built.js",
        outdir: tempDir,
        plugins: [createRoutesPlugin({ instances: [instance], target: "server" })],
        target: "bun",
      });
      expect(result.success).toBe(true);
      const output = result.outputs.find((artifact) => artifact.kind === "entry-point");
      if (!output) {
        throw new Error("Expected a bundled entry point");
      }

      const built = (await import(`${output.path}?t=${Date.now()}`)) as {
        furinApp: { handle(request: Request): Promise<Response> };
      };
      // The regular page still routes.
      const index = await built.furinApp.handle(new Request("http://localhost/"));
      expect(index.status).toBe(200);
      expect(await index.text()).toContain("underscore-index");
      // Co-located private files and directories never become routes.
      const components = await built.furinApp.handle(new Request("http://localhost/_components"));
      expect(components.status).toBe(404);
      const libHelpers = await built.furinApp.handle(
        new Request("http://localhost/_lib/helpers")
      );
      expect(libHelpers.status).toBe(404);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

describe("furin/routes client plugin", () => {
  test("emits the compact root manifest without Elysia", async () => {
    const instances = [
      { pagesDir: join(FIXTURES, "root"), prefix: "" },
      { pagesDir: join(FIXTURES, "admin"), prefix: "/admin" },
    ] satisfies RouteInstanceSpec[];
    const tempDir = mkdtempSync(join(import.meta.dir, ".tmp-routes-client-"));
    const entryPath = join(tempDir, "entry.ts");

    try {
      writeFileSync(entryPath, 'export { routes } from "furin/routes";\n');
      const result = await Bun.build({
        entrypoints: [entryPath],
        naming: "built.js",
        outdir: tempDir,
        plugins: [createRoutesPlugin({ instances, target: "client" })],
        target: "browser",
      });
      expect(result.success).toBe(true);
      const output = result.outputs.find((artifact) => artifact.kind === "entry-point");
      if (!output) {
        throw new Error("Expected a bundled entry point");
      }
      expect(await output.text()).not.toContain("elysia");

      const built = (await import(`${output.path}?t=${Date.now()}`)) as {
        routes: Array<{ hasLoader: boolean; mode: string; pattern: string }>;
      };
      expect(built.routes).toEqual([
        { hasLoader: true, mode: "ssg", pattern: "/" },
        { hasLoader: true, mode: "isr", pattern: "/boards/:id" },
      ]);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

describe("furin/routes type declaration", () => {
  test("generates one normalized RouteMap declaration", () => {
    expect(
      routeMapDeclaration([
        { importSpecifier: "./pages/boards/[id]", pattern: "/boards/:id" },
        { importSpecifier: "./pages/index", pattern: "/" },
      ])
    ).toBe(`declare module "@teyik0/furin/routes" {
  interface RouteMap {
    "/": typeof import("./pages/index").route;
    [path: \`/boards/\${string}\`]: typeof import("./pages/boards/[id]").route;
  }

  interface RoutePatternMap {
    "/": typeof import("./pages/index").route;
    "/boards/:id": typeof import("./pages/boards/[id]").route;
  }
}`);
  });

  test("escapes static template segments and normalizes wildcards", () => {
    const declaration = routeMapDeclaration([
      { importSpecifier: "./pages/docs", pattern: "/docs/`${literal}/:slug" },
      { importSpecifier: "./pages/files", pattern: "/files/*" },
    ]);

    expect(declaration).toContain(
      "[path: `/docs/\\`\\${literal}/${string}`]: typeof import(\"./pages/docs\").route;"
    );
    expect(declaration).toContain(
      "[path: `/files/${string}`]: typeof import(\"./pages/files\").route;"
    );
  });
});
