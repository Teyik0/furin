import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRoutesPlugin,
  routeModuleSpecifier,
  type RouteInstanceSpec,
} from "../../src/plugin/routes.ts";
import { routeMapDeclaration } from "../../src/shared/route-map.ts";

const FIXTURES = join(import.meta.dir, "../fixtures/routes-v2");

describe("furin/routes server plugin", () => {
  test("keeps generated route bindings unique for separator-like paths", async () => {
    const instance = { pagesDir: join(FIXTURES, "colliding-paths"), prefix: "" };
    const tempDir = mkdtempSync(join(tmpdir(), "furin-routes-bindings-"));
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
    const tempDir = mkdtempSync(join(tmpdir(), "furin-routes-catch-all-"));
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

      const response = await built.furinApp.handle(
        new Request("http://localhost/docs/guides/routing")
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ catchAllPath: "guides/routing" });
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  test("resolves one isolated Elysia app per mounted instance", async () => {
    const rootInstance = { pagesDir: join(FIXTURES, "root"), prefix: "" };
    const adminInstance = { pagesDir: join(FIXTURES, "admin"), prefix: "/admin" };
    const instances = [rootInstance, adminInstance] satisfies RouteInstanceSpec[];
    const tempDir = mkdtempSync(join(tmpdir(), "furin-routes-plugin-"));
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
    const tempDir = mkdtempSync(join(tmpdir(), "furin-routes-layout-"));
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
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ board: "42", user: "teyik" });
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  test("rejects dynamic paths without a matching params schema", async () => {
    const instance = { pagesDir: join(FIXTURES, "bad"), prefix: "" };
    const tempDir = mkdtempSync(join(tmpdir(), "furin-routes-drift-"));
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
    const tempDir = mkdtempSync(join(tmpdir(), "furin-routes-underscore-"));
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
    const tempDir = mkdtempSync(join(tmpdir(), "furin-routes-client-"));
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
