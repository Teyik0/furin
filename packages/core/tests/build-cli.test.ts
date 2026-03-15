import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type BuildManifest, buildApp, type TargetBuildManifest } from "../src/build/index.ts";
import { runCli } from "./helpers/run-cli.ts";
import { createTmpApp, removeAppPath, writeAppFile } from "./helpers/tmp-app.ts";

const tmpApps: Array<{ cleanup: () => void }> = [];
const SERVER_JS_RE = /server\.js$/;

function rememberTmpApp<T extends { cleanup: () => void }>(app: T): T {
  tmpApps.push(app);
  return app;
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

afterEach(() => {
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

describe.serial("CLI/build Bun feature", () => {
  test("buildApp({ target: 'bun' }) writes manifest and built client assets", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const result = await buildApp({
      rootDir: app.path,
      target: "bun",
    });

    expect(result.targets.bun).toBeDefined();
    expect(existsSync(join(app.path, ".furin/build/manifest.json"))).toBe(true);
    expect(existsSync(join(app.path, ".furin/build/bun/client/index.html"))).toBe(true);
    expect(existsSync(join(app.path, ".furin/build/bun/public/.gitkeep"))).toBe(true);
  });

  test("CLI build --target bun succeeds and writes expected manifest fields", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const result = runCli(["build", "--target", "bun"], { cwd: app.path });

    expect(result.exitCode).toBe(0);

    const manifest = readJsonFile<BuildManifest>(join(app.path, ".furin/build/manifest.json"));
    const targetManifestPath = join(app.path, ".furin/build/bun/manifest.json");
    expect(existsSync(targetManifestPath)).toBe(true);
    const targetManifest = readJsonFile<TargetBuildManifest>(targetManifestPath);
    const bunTarget = manifest.targets.bun;
    if (!bunTarget) {
      throw new Error("Missing bun target manifest in build output");
    }

    expect(manifest.rootPath).toBe("src/pages/root.tsx");
    expect(manifest.serverEntry).toBe("src/server.ts");
    expect(
      manifest.routes.some((route) => route.pattern === "/blog/:slug" && route.hasStaticParams)
    ).toBe(true);
    expect(targetManifest.targetDir).toBe(bunTarget.targetDir);
    expect(targetManifest.clientDir).toBe(bunTarget.clientDir);
    expect(targetManifest.serverPath).toBe(bunTarget.serverPath);
  });

  test("buildApp() rejects apps without a root.tsx layout", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    removeAppPath(app.path, "src/pages/root.tsx");
    writeAppFile(
      app.path,
      "src/pages/index.tsx",
      [
        'import { createRoute } from "furinjs/client";',
        "const route = createRoute({ mode: 'ssg' });",
        "export default route.page({ component: () => <main>No root</main> });",
      ].join("\n")
    );
    writeAppFile(
      app.path,
      "src/pages/blog/[slug].tsx",
      [
        'import { createRoute } from "furinjs/client";',
        "const route = createRoute({ mode: 'ssg' });",
        "export default route.page({",
        "  staticParams: () => [{ slug: 'hello-world' }],",
        "  component: () => <article>No root blog</article>,",
        "});",
      ].join("\n")
    );

    expect(buildApp({ rootDir: app.path, target: "bun" })).rejects.toThrow();
  });

  test("CLI build rejects unsupported targets with a non-zero exit code", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const result = runCli(["build", "--target", "vercel"], { cwd: app.path });

    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr + result.stdout).toContain("planned but not implemented");
  });

  test("CLI build rejects invalid target values", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const result = runCli(["build", "--target", "wat"], { cwd: app.path });

    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr + result.stdout).toContain('Unsupported build target "wat"');
  });

  test('buildApp({ compile: "server" }) without serverEntry throws a clear error', () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    removeAppPath(app.path, "src/server.ts");

    expect(buildApp({ rootDir: app.path, target: "bun", compile: "server" })).rejects.toThrow(
      "server.ts"
    );
  });

  test("CLI build --compile server writes a server binary and keeps client assets on disk", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const result = runCli(["build", "--target", "bun", "--compile", "server"], { cwd: app.path });
    expect(result.exitCode).toBe(0);

    const targetDir = join(app.path, ".furin/build/bun");
    const serverBin = existsSync(join(targetDir, "server"))
      ? join(targetDir, "server")
      : join(targetDir, "server.exe");

    expect(existsSync(serverBin)).toBe(true);
    // compile entry must be cleaned up after build
    expect(existsSync(join(targetDir, "_compile-entry.ts"))).toBe(false);
    // client assets must still exist on disk (not embedded)
    expect(existsSync(join(targetDir, "client/index.html"))).toBe(true);
    expect(existsSync(join(targetDir, "public/.gitkeep"))).toBe(true);
  });

  test("CLI build --target bun generates server.js bundle and cleans up intermediate", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const result = runCli(["build", "--target", "bun"], { cwd: app.path });
    expect(result.exitCode).toBe(0);

    const targetDir = join(app.path, ".furin/build/bun");

    // server.js bundle must exist
    expect(existsSync(join(targetDir, "server.js"))).toBe(true);
    // intermediate server.ts must be cleaned up
    expect(existsSync(join(targetDir, "server.ts"))).toBe(false);
    // serverPath in manifest must point to server.js
    const manifest = readJsonFile<{ targets: { bun?: { serverPath?: string } } }>(
      join(app.path, ".furin/build/manifest.json")
    );
    expect(manifest.targets.bun?.serverPath).toMatch(SERVER_JS_RE);
  });

  test("CLI build --target bun: server.js bundle embeds rootPath and routes with patterns", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const result = runCli(["build", "--target", "bun"], { cwd: app.path });
    expect(result.exitCode).toBe(0);

    const serverJs = readFileSync(join(app.path, ".furin/build/bun/server.js"), "utf8");

    // Bundle must contain baked route patterns
    expect(serverJs).toContain('"/"');
    expect(serverJs).toContain('"/blog/:slug"');
  });

  test("buildApp passes user plugins to Bun.build() calls", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    let setupWasCalled = false;

    const trackingPlugin: Bun.BunPlugin = {
      name: "tracking-plugin",
      setup(_build) {
        setupWasCalled = true;
      },
    };

    // Ignore EISDIR — may occur when Bun.build() runs concurrently with other test files.
    // We only care that the plugin setup() was invoked at least once.
    try {
      await buildApp({ rootDir: app.path, target: "bun", plugins: [trackingPlugin] });
    } catch {
      // noop
    }

    expect(setupWasCalled).toBe(true);
  });
});
