import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { getFreePort } from "../support/hmr.ts";
import { waitForHttp } from "../support/http.ts";
import { startCli } from "../support/process.ts";

const CLI_APP = resolve(import.meta.dir, "../fixtures/apps/cli-app");

function createDevelopmentServer(source: string): string {
  const directory = mkdtempSync(resolve(tmpdir(), "furin-dev-command-"));
  const sourceDirectory = resolve(directory, "src");
  mkdirSync(sourceDirectory);
  writeFileSync(resolve(sourceDirectory, "server.ts"), source);
  return directory;
}

test("furin dev rejects an invalid port before starting the application", async () => {
  const cli = startCli(["dev", "--port", "70000"], { cwd: CLI_APP });
  const exitCode = await cli.exitCode;

  expect(exitCode).toBe(1);
  expect(cli.getStderr()).toContain("Invalid development port");
});

test("furin dev prints the application and dedicated DevTools URLs", async () => {
  const directory = createDevelopmentServer(`Bun.serve({
  port: Number(process.env.PORT),
  fetch(request) {
    return new URL(request.url).pathname === "/_furin/devtools"
      ? new Response("<title>Furin DevTools</title>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      : new Response("Not found", { status: 404 });
  },
});`);
  const port = await getFreePort();
  const cli = startCli(["dev", "--port", String(port)], { cwd: directory });

  try {
    const response = await waitForHttp(`http://localhost:${port}/_furin/devtools`, {
      timeoutMs: 10_000,
    });

    expect(await response.text()).toContain("<title>Furin DevTools</title>");
    expect(cli.getStdout()).toContain(`Local:     http://localhost:${port}/`);
    expect(cli.getStdout()).toContain(`DevTools:  http://localhost:${port}/_furin/devtools`);
  } finally {
    cli.kill();
    await cli.exitCode;
    rmSync(directory, { force: true, recursive: true });
  }
});

test("furin dev discovers a prefixed instance dashboard", async () => {
  const directory = createDevelopmentServer(`if (false) {
  furin({ pagesDir: "./pages", prefix: "/admin" });
}
Bun.serve({
  port: Number(process.env.PORT),
  fetch(request) {
    return new URL(request.url).pathname === "/admin/_furin/devtools"
      ? new Response("Admin DevTools")
      : new Response("Not found", { status: 404 });
  },
});`);
  writeFileSync(resolve(directory, "furin.config.ts"), "export default { apps: [] };\n");
  const port = await getFreePort();
  const cli = startCli(["dev", "--port", String(port)], { cwd: directory });

  try {
    const response = await waitForHttp(`http://localhost:${port}/admin/_furin/devtools`, {
      timeoutMs: 10_000,
    });
    await response.body?.cancel();

    expect(cli.getStdout()).toContain(
      `DevTools:  http://localhost:${port}/admin/_furin/devtools`
    );
    expect(cli.getStdout()).not.toContain(`DevTools:  http://localhost:${port}/_furin/devtools`);
  } finally {
    cli.kill();
    await cli.exitCode;
    rmSync(directory, { force: true, recursive: true });
  }
});

test("furin dev aborts a stalled readiness request when the child exits", async () => {
  const directory = createDevelopmentServer(`const server = Bun.listen({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  socket: { data() {}, open() {} },
});
setTimeout(() => {
  server.stop(true);
  process.exit(0);
}, 250);`);
  const port = await getFreePort();
  const cli = startCli(["dev", "--port", String(port), "--open-devtools"], {
    cwd: directory,
  });

  try {
    const exitCode = await Promise.race([
      cli.exitCode,
      Bun.sleep(3000).then(() => Number.NaN),
    ]);
    expect(exitCode).toBe(0);
  } finally {
    cli.kill();
    await cli.exitCode;
    rmSync(directory, { force: true, recursive: true });
  }
});
