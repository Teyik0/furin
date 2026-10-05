import { expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type Elysia from "elysia";
import { createTmpApp } from "../support/app-fixtures.ts";
import { runCli } from "../support/process.ts";

test("CLI app output is inert, relocatable and serves the composed application in the host", async () => {
  const fixture = createTmpApp("cli-app");
  let app: Elysia | undefined;
  try {
    const sourcePath = join(fixture.path, "src/server.ts");
    writeFileSync(sourcePath, readFileSync(sourcePath, "utf8")
      .replace("const app = new Elysia().use(", 'const app = new Elysia().request(({ set }) => { set.headers["x-source-hook"] = "preserved"; }).get("/api/host", () => ({ host: true })).use(')
      .replace("export default app;", 'export const onShutdown = () => "shutdown";\nexport const startServer = () => { throw new Error("must not start"); };\nexport default app;'));
    writeFileSync(join(fixture.path, "public/portable.txt"), "portable asset");
    const pagePath = join(fixture.path, "src/pages/index.tsx");
    writeFileSync(pagePath, readFileSync(pagePath, "utf8").replace('mode: "ssg"', 'mode: "ssr"'));
    const built = await runCli(["build", "--target", "bun", "--output", "app"], { cwd: fixture.path });
    expect(built.exitCode, built.stderr + built.stdout).toBe(0);
    const output = join(fixture.path, ".furin/build/bun");
    expect(existsSync(join(output, "app.js"))).toBe(true);
    expect(existsSync(join(output, "server.js"))).toBe(false);
    const relocated = join(fixture.path, "relocated");
    renameSync(output, relocated);
    renameSync(join(fixture.path, "src"), join(fixture.path, "source-not-deployed"));
    renameSync(join(fixture.path, "public"), join(fixture.path, "public-not-deployed"));
    const originalServe = Bun.serve;
    let imported: { default: Elysia; onShutdown: () => string };
    try {
      Bun.serve = (() => { throw new Error("import must not listen"); }) as typeof Bun.serve;
      imported = await import(pathToFileURL(join(relocated, "app.js")).href);
    } finally {
      Bun.serve = originalServe;
    }
    app = imported.default;
    expect(imported.onShutdown()).toBe("shutdown");
    expect(app.server).toBeUndefined();
    app.request(({ request }) => {
      if (new URL(request.url).pathname === "/host-denied") {
        return new Response("Host guard", { status: 403 });
      }
    });
    expect(await (await app.handle(new Request("http://localhost/api/host"))).json()).toEqual({ host: true });
    app.listen(0);
    const url = app.server?.url;
    expect(url).toBeDefined();
    const api = await fetch(new URL("/api/host", url));
    expect(await api.json()).toEqual({ host: true });
    expect(api.headers.get("x-source-hook")).toBe("preserved");
    const denied = await fetch(new URL("/host-denied", url));
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe("Host guard");
    const page = await fetch(new URL("/", url));
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("Home");
    const clientAsset = html.match(/src="([^"]+\.js[^"]*)"/)?.[1];
    expect(clientAsset).toBeDefined();
    expect((await fetch(new URL(clientAsset!, url))).status).toBe(200);
    expect(await (await fetch(new URL("/public/portable.txt", url))).text()).toBe("portable asset");
  } finally {
    await app?.stop(true);
    fixture.cleanup();
  }
}, 30_000);

test("CLI rejects Bun output for other targets and compiled applications", async () => {
  const fixture = createTmpApp("cli-app");
  try {
    for (const target of ["static", "package", "vercel", "all"]) {
      const result = await runCli(["build", "--target", target, "--output", "app"], { cwd: fixture.path });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--output requires --target bun");
    }
    const result = await runCli(["build", "--output", "app", "--compile", "server"], { cwd: fixture.path });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("cannot be combined with compile");
  } finally {
    fixture.cleanup();
  }
}, 30_000);

test("configuration selects app output and CLI can override it back to server", async () => {
  const fixture = createTmpApp("cli-app");
  try {
    writeFileSync(join(fixture.path, "furin.config.ts"), 'export default { bun: { output: "app" } };\n');
    const appBuild = await runCli(["build", "--target", "bun"], { cwd: fixture.path });
    expect(appBuild.exitCode, appBuild.stderr + appBuild.stdout).toBe(0);
    expect(existsSync(join(fixture.path, ".furin/build/bun/app.js"))).toBe(true);
    const serverBuild = await runCli(["build", "--target", "bun", "--output", "server"], { cwd: fixture.path });
    expect(serverBuild.exitCode, serverBuild.stderr + serverBuild.stdout).toBe(0);
    expect(existsSync(join(fixture.path, ".furin/build/bun/server.js"))).toBe(true);
    expect(existsSync(join(fixture.path, ".furin/build/bun/app.js"))).toBe(false);
    const invalid = await runCli(["build", "--output", "invalid"], { cwd: fixture.path });
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain('Invalid Bun output "invalid"');
  } finally {
    fixture.cleanup();
  }
}, 30_000);
