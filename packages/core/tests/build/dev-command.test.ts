import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { getFreePort } from "../support/hmr.ts";
import { waitForHttp } from "../support/http.ts";
import { withBuildTestLock } from "../support/build-lock.ts";
import { startCli } from "../support/process.ts";

const CLI_APP = resolve(import.meta.dir, "../fixtures/apps/cli-app");
const TEST_TMP_ROOT = resolve(import.meta.dir, "../.tmp-tests");

interface DevtoolsEventSnapshot {
  events: Array<{
    changedModules?: string[];
    error?: {
      file: string | null;
      message: string;
      stack: string | null;
    };
    type: string;
  }>;
}

async function waitForHmrCycle(url: string, deadline: number): Promise<string[]> {
  const response = await fetch(url);
  const snapshot = (await response.json()) as DevtoolsEventSnapshot;
  const cycle = snapshot.events.findLast((event) => event.type === "hmr.server.finished");
  if (cycle?.changedModules) {
    return cycle.changedModules;
  }
  if (Date.now() >= deadline) {
    throw new Error("Timed out waiting for a watcher-backed HMR cycle");
  }
  await Bun.sleep(50);
  return waitForHmrCycle(url, deadline);
}

async function waitForDevError(
  url: string,
  deadline: number
): Promise<NonNullable<DevtoolsEventSnapshot["events"][number]["error"]>> {
  const response = await fetch(url);
  const snapshot = (await response.json()) as DevtoolsEventSnapshot;
  const error = snapshot.events.findLast((event) => event.type === "dev.error")?.error;
  if (error) {
    return error;
  }
  if (Date.now() >= deadline) {
    throw new Error("Timed out waiting for a DevTools development error");
  }
  await Bun.sleep(50);
  return waitForDevError(url, deadline);
}

test("furin dev rejects an invalid port before starting the application", async () => {
  const cli = startCli(["dev", "--port", "70000"], { cwd: CLI_APP });
  const exitCode = await cli.exitCode;

  expect(exitCode).toBe(1);
  expect(cli.getStderr()).toContain("Invalid development port");
});

test("furin dev prints the application and dedicated DevTools URLs", () =>
  withBuildTestLock(async () => {
    mkdirSync(TEST_TMP_ROOT, { recursive: true });
    const appDirectory = mkdtempSync(resolve(TEST_TMP_ROOT, "dev-command-"));
    cpSync(CLI_APP, appDirectory, { recursive: true });
    const indexRoute = resolve(appDirectory, "src/pages/index.tsx");
    const port = await getFreePort();
    const cli = startCli(["dev", "--port", String(port)], { cwd: appDirectory });
    const initialRoute = readFileSync(indexRoute, "utf8");
    try {
      const response = await waitForHttp(`http://localhost:${port}/_furin/devtools`, {
        timeoutMs: 20_000,
      });
      const html = await response.text();
      const dashboardResponse = await fetch(
        `http://localhost:${port}/_furin/devtools/dashboard.js`
      );
      const dashboardSource = await dashboardResponse.text();
      const stylesResponse = await fetch(
        `http://localhost:${port}/_furin/devtools/dashboard.css`
      );

      expect(html).toContain("<title>Furin DevTools</title>");
      expect(dashboardResponse.headers.get("content-type")).toContain("text/javascript");
      expect(dashboardSource).toContain("Hot module replacement");
      expect(stylesResponse.headers.get("content-type")).toContain("text/css");
      expect(cli.getStdout()).toContain(`Local:     http://localhost:${port}/`);
      expect(cli.getStdout()).toContain(`DevTools:  http://localhost:${port}/_furin/devtools`);

      writeFileSync(indexRoute, `${initialRoute}\n`);
      const changedModules = await waitForHmrCycle(
        `http://localhost:${port}/_furin/devtools/snapshot`,
        Date.now() + 10_000
      );
      expect(changedModules).toContain("src/pages/index.tsx");
      const diagnosticResponse = await fetch(
        `http://localhost:${port}/_furin/devtools/snapshot`
      );
      const diagnostics = (await diagnosticResponse.json()) as DevtoolsEventSnapshot;
      expect(diagnostics.events.some((event) => event.type === "dev.ready")).toBe(true);

      writeFileSync(indexRoute, "export const route = ;\n");
      const devError = await waitForDevError(
        `http://localhost:${port}/_furin/devtools/snapshot`,
        Date.now() + 10_000
      );
      expect(devError.file).toBe("src/pages/index.tsx");
      expect(devError.message).not.toContain(appDirectory);
      expect(devError.stack).toBeNull();
    } finally {
      writeFileSync(indexRoute, initialRoute);
      cli.kill();
      await cli.exitCode;
      rmSync(appDirectory, { force: true, recursive: true });
    }
  }));

test("furin dev aborts a stalled readiness request when the child exits", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "furin-dev-stalled-"));
  const sourceDirectory = resolve(directory, "src");
  mkdirSync(sourceDirectory);
  writeFileSync(
    resolve(sourceDirectory, "server.ts"),
    `const server = Bun.listen({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  socket: { data() {}, open() {} },
});
setTimeout(() => {
  server.stop(true);
  process.exit(0);
}, 250);
`
  );
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
