import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateCompileEntry } from "../src/build/compile-entry";
import { runCli } from "./helpers/run-cli";
import { createTmpApp, removeAppPath } from "./helpers/tmp-app";

const tmpApps: Array<{ cleanup: () => void }> = [];

function rememberTmpApp<T extends { cleanup: () => void }>(app: T): T {
  tmpApps.push(app);
  return app;
}

afterEach(() => {
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

describe.serial("compile: embed", () => {
  // Compile tests use runCli (subprocess) to avoid Bun.build({ compile }) EISDIR race

  test("CLI build --compile embed without server entry fails with clear error", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    removeAppPath(app.path, "src/server.ts");

    const result = runCli(["build", "--compile", "embed"], { cwd: app.path });

    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr + result.stdout).toContain("server.ts");
  });

  test("CLI build --compile embed writes a single server binary", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const result = runCli(["build", "--compile", "embed"], { cwd: app.path });

    expect(result.exitCode).toBe(0);
    const targetDir = join(app.path, ".furin/build/bun");
    const serverBin = existsSync(join(targetDir, "server"))
      ? join(targetDir, "server")
      : join(targetDir, "server.exe");

    expect(existsSync(serverBin)).toBe(true);

    // All intermediate files must be cleaned up — only the binary + manifest should remain.
    for (const file of [
      "client",
      "_hydrate.tsx",
      "index.html",
      "_compile-entry.ts",
      "_compile-entry.js.map",
    ]) {
      expect(existsSync(join(targetDir, file))).toBe(false);
    }
  });

  test("generateCompileEntry with embed produces file imports and __setCompileContext", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const clientDir = join(app.path, "fake-client");
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(join(clientDir, "index.html"), "<html></html>");
    writeFileSync(join(clientDir, "chunk-abc.js"), "console.log()");
    writeFileSync(join(app.path, "public", "logo.png"), "fake");
    mkdirSync(join(app.path, "public", "sub"), { recursive: true });
    writeFileSync(join(app.path, "public", "sub", "logo.png"), "fake");

    const entryPath = generateCompileEntry({
      rootPath: join(app.path, "src/pages/root.tsx"),
      routes: [{ pattern: "/", path: join(app.path, "src/pages/index.tsx"), mode: "ssg" }],
      serverEntry: join(app.path, "src/server.ts"),
      outDir: app.path,
      embed: { clientDir },
      publicDir: join(app.path, "public"),
    });

    expect(existsSync(entryPath)).toBe(true);
    const content = readFileSync(entryPath, "utf8");

    expect(content).toContain('with { type: "file" }');
    expect(content).toContain("__setCompileContext");
    expect(content).toContain("embedded:");
    expect(content).toContain("modules:");
    expect(content).toContain("import(");
    expect(content).toContain("/public/logo.png");
    expect(content).toContain("/public/sub/logo.png");
  });

  test("generateCompileEntry without embed does not contain embedded block", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const entryPath = generateCompileEntry({
      rootPath: join(app.path, "src/pages/root.tsx"),
      routes: [{ pattern: "/", path: join(app.path, "src/pages/index.tsx"), mode: "ssg" }],
      serverEntry: join(app.path, "src/server.ts"),
      outDir: app.path,
    });

    const content = readFileSync(entryPath, "utf8");

    expect(content).toContain("__setCompileContext");
    expect(content).toContain("modules:");
    expect(content).not.toContain("embedded:");
    expect(content).not.toContain('with { type: "file" }');
  });

  test("generateCompileEntry with embed throws if clientDir does not exist", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    expect(() =>
      generateCompileEntry({
        rootPath: join(app.path, "src/pages/root.tsx"),
        routes: [],
        serverEntry: join(app.path, "src/server.ts"),
        outDir: app.path,
        embed: { clientDir: join(app.path, "nonexistent") },
      })
    ).toThrow("Client directory not found");
  });

  test("generateCompileEntry with embed throws if index.html is missing", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const clientDir = join(app.path, "fake-client");
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(join(clientDir, "chunk-abc.js"), "console.log()");

    expect(() =>
      generateCompileEntry({
        rootPath: join(app.path, "src/pages/root.tsx"),
        routes: [],
        serverEntry: join(app.path, "src/server.ts"),
        outDir: app.path,
        embed: { clientDir },
      })
    ).toThrow("index.html");
  });
});
