import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateCompileEntry } from "../../../src/build/compile-entry";
import { runCli } from "../../support/process";
import { createTmpApp, removeAppPath } from "../../support/app-fixtures";

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

  test("CLI build --compile embed without server entry fails with clear error", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    removeAppPath(app.path, "src/server.ts");

    const result = await runCli(["build", "--compile", "embed"], { cwd: app.path });

    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr + result.stdout).toContain("server.ts");
  });

  test("CLI build --compile embed writes a single server binary", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const result = await runCli(["build", "--compile", "embed"], { cwd: app.path });

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

  test("CLI build --compile=embed writes a single server binary", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const result = await runCli(["build", "--compile=embed"], { cwd: app.path });

    expect(result.exitCode).toBe(0);
    const targetDir = join(app.path, ".furin/build/bun");
    const serverBin = existsSync(join(targetDir, "server"))
      ? join(targetDir, "server")
      : join(targetDir, "server.exe");

    expect(existsSync(serverBin)).toBe(true);
    expect(existsSync(join(targetDir, "client"))).toBe(false);
  });

  test("CLI build rejects unknown flags", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const result = await runCli(["build", "--targte", "bun"], { cwd: app.path });

    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr + result.stdout).toContain("Unknown option");
  });

  test("CLI build does not parse --compile after the option terminator", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const result = await runCli(["build", "--", "--compile=invalid"], { cwd: app.path });
    const output = result.stderr + result.stdout;

    expect(result.exitCode).toBeGreaterThan(0);
    expect(output).toContain("Unexpected argument");
    expect(output).not.toContain("Invalid compile mode");
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
      apps: [
        {
          buildId: undefined,
          clientLogging: true,
          rootPath: join(app.path, "src/pages/root.tsx"),
          routes: [{ pattern: "/", path: join(app.path, "src/pages/index.tsx"), mode: "ssg" }],
          rootConventions: undefined,
          routeMetadata: undefined,
          embed: { clientDir },
        },
      ],
      serverEntry: join(app.path, "src/server.ts"),
      outDir: app.path,
      publicDir: join(app.path, "public"),
    });

    expect(existsSync(entryPath)).toBe(true);
    const content = readFileSync(entryPath, "utf8");

    expect(content).toContain('with { type: "file" }');
    expect(content).toContain("__setCompileContext");
    expect(content).toContain("clientLogging: true");
    expect(content).toContain("embedded:");
    expect(content).toContain("modules:");
    expect(content).toContain("import(");
    expect(content).toContain("/public/logo.png");
    expect(content).toContain("/public/sub/logo.png");
  });

  test("generateCompileEntry embeds public assets into every app's context", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    // Two embedded apps sharing one project-level public/ dir — each instance
    // serves only from its own embedded.assets, so both need the /public keys.
    const clientDirs = [join(app.path, "fake-client-a"), join(app.path, "fake-client-b")];
    for (const clientDir of clientDirs) {
      mkdirSync(clientDir, { recursive: true });
      writeFileSync(join(clientDir, "index.html"), "<html></html>");
    }
    writeFileSync(join(app.path, "public", "logo.png"), "fake");

    const entryPath = generateCompileEntry({
      apps: [
        {
          rootPath: join(app.path, "src/pages/root.tsx"),
          routes: [],
          embed: { clientDir: clientDirs[0] as string },
        },
        {
          rootPath: join(app.path, "src/pages/root.tsx"),
          routes: [],
          prefix: "/admin",
          embed: { clientDir: clientDirs[1] as string },
        },
      ],
      serverEntry: join(app.path, "src/server.ts"),
      outDir: app.path,
      publicDir: join(app.path, "public"),
    });

    const content = readFileSync(entryPath, "utf8");

    // Both apps' asset maps carry the /public key, each via its own var namespace…
    const publicLines = content.split("\n").filter((line) => line.includes('"/public/logo.png"'));
    expect(publicLines).toHaveLength(2);
    expect(publicLines[0]).toContain("_a0_");
    expect(publicLines[1]).toContain("_a1_");
    // …but both import the SAME file path, which Bun dedupes into one embedded payload.
    expect(content.split('"./public/logo.png"')).toHaveLength(3);
  });

  test("generateCompileEntry with embed excludes client sourcemaps", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const clientDir = join(app.path, "fake-client");
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(join(clientDir, "index.html"), "<html></html>");
    writeFileSync(join(clientDir, "chunk-abc.js"), "console.log()");
    writeFileSync(join(clientDir, "chunk-abc.js.map"), "{}");
    writeFileSync(join(clientDir, "style.css"), "body{}");
    writeFileSync(join(clientDir, "style.css.map"), "{}");

    const entryPath = generateCompileEntry({
      apps: [
        {
          buildId: undefined,
          rootPath: join(app.path, "src/pages/root.tsx"),
          routes: [{ pattern: "/", path: join(app.path, "src/pages/index.tsx"), mode: "ssg" }],
          rootConventions: undefined,
          routeMetadata: undefined,
          embed: { clientDir },
        },
      ],
      serverEntry: join(app.path, "src/server.ts"),
      outDir: app.path,
    });

    const content = readFileSync(entryPath, "utf8");

    expect(content).toContain("/_client/chunk-abc.js");
    expect(content).toContain("/_client/style.css");
    expect(content).not.toContain(".map");
  });

  test("generateCompileEntry without embed does not contain embedded block", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const entryPath = generateCompileEntry({
      apps: [
        {
          buildId: undefined,
          rootPath: join(app.path, "src/pages/root.tsx"),
          routes: [{ pattern: "/", path: join(app.path, "src/pages/index.tsx"), mode: "ssg" }],
          rootConventions: undefined,
          routeMetadata: undefined,
        },
      ],
      serverEntry: join(app.path, "src/server.ts"),
      outDir: app.path,
    });

    const content = readFileSync(entryPath, "utf8");

    expect(content).toContain("__setCompileContext");
    expect(content).toContain("modules:");
    expect(content).not.toContain("embedded:");
    expect(content).not.toContain('with { type: "file" }');
  });

  test("generateCompileEntry stores the composed native app in its compile context", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    const nativeRoutes = "@teyik0/furin/routes?instance=test";

    const entryPath = generateCompileEntry({
      apps: [
        {
          nativeRoutes,
          rootPath: join(app.path, "src/pages/root.tsx"),
          routes: [],
        },
      ],
      outDir: app.path,
    });

    const content = readFileSync(entryPath, "utf8");
    expect(content).toContain(
      `import { furinApp as _furinApp } from ${JSON.stringify(nativeRoutes)};`
    );
    expect(content).toContain("nativeRoutes: _furinApp,");
  });

  test("generateCompileEntry with embed throws if clientDir does not exist", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    expect(() =>
      generateCompileEntry({
        apps: [
          {
            rootPath: join(app.path, "src/pages/root.tsx"),
            routes: [],
            embed: { clientDir: join(app.path, "nonexistent") },
          },
        ],
        serverEntry: join(app.path, "src/server.ts"),
        outDir: app.path,
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
        apps: [
          {
            rootPath: join(app.path, "src/pages/root.tsx"),
            routes: [],
            embed: { clientDir },
          },
        ],
        serverEntry: join(app.path, "src/server.ts"),
        outDir: app.path,
      })
    ).toThrow("index.html");
  });
});
