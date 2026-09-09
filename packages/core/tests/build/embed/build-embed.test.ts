import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateCompileEntry } from "../../../src/build/compile-entry";
import { createTmpApp, removeAppPath } from "../../support/app-fixtures";
import { getTestPort, waitForHttp } from "../../support/http";
import { runCli, startProcess } from "../../support/process";

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

  test("CLI build --compile embed writes a runnable single server binary", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeFileSync(join(app.path, "public/embed.txt"), "embedded public asset");

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

    const port = getTestPort();
    const server = startProcess([serverBin], {
      cwd: app.path,
      env: { PORT: String(port) },
    });
    try {
      const response = await waitForHttp(`http://127.0.0.1:${port}/`, {
        timeoutMs: 10_000,
      });
      const html = await response.text();
      expect(html).toContain("Home page");

      const publicAsset = await fetch(`http://127.0.0.1:${port}/public/embed.txt`);
      expect(publicAsset.status).toBe(200);
      expect(await publicAsset.text()).toBe("embedded public asset");

      const clientAssetPath = html.match(/src="([^"]+\.js)"/)?.[1];
      expect(clientAssetPath).toBeDefined();
      const clientAsset = await fetch(`http://127.0.0.1:${port}${clientAssetPath}`);
      expect(clientAsset.status).toBe(200);
      expect(clientAsset.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    } finally {
      server.kill();
      await server.exitCode;
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

  test("CLI build --analyze writes a complete client metafile", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const result = await runCli(["build", "--target", "bun", "--analyze"], {
      cwd: app.path,
    });

    expect(result.exitCode).toBe(0);
    const metafile = Bun.file(join(app.path, ".furin/build/analysis/bun-client.json"));
    expect(await metafile.exists()).toBe(true);
    const metadata = (await metafile.json()) as Bun.BuildMetafile;
    expect(Object.keys(metadata.inputs).length).toBeGreaterThan(0);
    expect(Object.keys(metadata.outputs).length).toBeGreaterThan(0);
  });

  test("CLI build does not parse --compile after the option terminator", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const result = await runCli(["build", "--", "--compile=invalid"], { cwd: app.path });
    const output = result.stderr + result.stdout;

    expect(result.exitCode).toBeGreaterThan(0);
    expect(output).toContain("Unexpected argument");
    expect(output).not.toContain("Invalid compile mode");
  });

  test("generateCompileEntry with embed produces an in-memory native directory context", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const clientDir = join(app.path, "fake-client");
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(join(clientDir, "index.html"), "<html></html>");
    writeFileSync(join(clientDir, "chunk-abc.js"), "console.log()");
    writeFileSync(join(app.path, "public", "logo.png"), "fake");
    mkdirSync(join(app.path, "public", "sub"), { recursive: true });
    writeFileSync(join(app.path, "public", "sub", "logo.png"), "fake");

    const entry = generateCompileEntry({
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

    expect(existsSync(entry.entrypoint)).toBe(false);
    const content = entry.files[entry.entrypoint] as string;

    expect(content).toContain("__setCompileContext");
    expect(content).toContain("clientLogging: true");
    expect(content).toContain("embedded:");
    expect(content).toContain("clientDir: import.meta.dir");
    expect(content).toContain("modules:");
    expect(content).toContain("import(");
    expect(content).toContain("publicDir: import.meta.dir");
    expect(content).not.toContain('with { type: "file" }');
    expect(content).not.toContain("/public/logo.png");
  });

  test("generateCompileEntry shares Bun's embedded public directory across app contexts", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    // Two embedded apps share one project-level public directory in BunFS.
    const clientDirs = [join(app.path, "fake-client-a"), join(app.path, "fake-client-b")];
    for (const clientDir of clientDirs) {
      mkdirSync(clientDir, { recursive: true });
      writeFileSync(join(clientDir, "index.html"), "<html></html>");
    }
    writeFileSync(join(app.path, "public", "logo.png"), "fake");

    const entry = generateCompileEntry({
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

    const content = entry.files[entry.entrypoint] as string;

    const publicLines = content.split("\n").filter((line) => line.includes("publicDir:"));
    expect(publicLines).toHaveLength(2);
    expect(content).not.toContain("/public/logo.png");
  });

  test("generateCompileEntry with embed does not enumerate client files", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const clientDir = join(app.path, "fake-client");
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(join(clientDir, "index.html"), "<html></html>");
    writeFileSync(join(clientDir, "chunk-abc.js"), "console.log()");
    writeFileSync(join(clientDir, "chunk-abc.js.map"), "{}");
    writeFileSync(join(clientDir, "style.css"), "body{}");
    writeFileSync(join(clientDir, "style.css.map"), "{}");

    const entry = generateCompileEntry({
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

    const content = entry.files[entry.entrypoint] as string;

    expect(content).toContain("clientDir: import.meta.dir");
    expect(content).not.toContain("chunk-abc.js");
    expect(content).not.toContain("style.css");
    expect(content).not.toContain(".map");
  });

  test("generateCompileEntry without embed does not contain embedded block", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const entry = generateCompileEntry({
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

    const content = entry.files[entry.entrypoint] as string;

    expect(content).toContain("__setCompileContext");
    expect(content).toContain("modules:");
    expect(content).not.toContain("embedded:");
    expect(content).not.toContain('with { type: "file" }');
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
