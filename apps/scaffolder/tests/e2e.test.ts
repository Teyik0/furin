import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ENTRY = resolve(import.meta.dir, "../src/index.ts");
const createdDirs: string[] = [];
const runningServers: Array<{ kill: () => void }> = [];

afterEach(() => {
  for (const server of runningServers.splice(0)) {
    server.kill();
  }

  while (createdDirs.length > 0) {
    const path = createdDirs.pop();
    if (path) {
      rmSync(path, { force: true, recursive: true });
    }
  }
});

describe.serial("create-furin e2e", () => {
  test("scaffolds the minimal template and verifies SSR loader output", async () => {
    const appPath = scaffoldTemplate("minimal");

    expect(existsSync(join(appPath, "src/api/hello.ts"))).toBe(true);

    assertSuccess(runCommand(["bun", "run", "test:types"], appPath));
    assertSuccess(runCommand(["bun", "run", "build"], appPath));

    const html = await fetchRenderedHome(appPath, 4311);
    expect(html).not.toContain("Plugin Error");
    expect(html).toContain("Frontend rendered by Furin");
    expect(html).toContain("Hello from Elysia");
    expect(html).toContain("Loaded via");
    expect(html).toContain("api:/api/hello");
  }, 120_000);

  test("scaffolds the shadcn template and verifies SSR loader output", async () => {
    const appPath = scaffoldTemplate("shadcn");

    expect(existsSync(join(appPath, "components.json"))).toBe(true);

    assertSuccess(runCommand(["bun", "run", "test:types"], appPath));
    assertSuccess(runCommand(["bun", "run", "build"], appPath));

    const html = await fetchRenderedHome(appPath, 4312);
    expect(html).not.toContain("Plugin Error");
    expect(html).toContain("shadcn/ui is ready");
    expect(html).toContain("Hello from Elysia");
  }, 120_000);
});

function scaffoldTemplate(template: "minimal" | "shadcn"): string {
  const rootDir = mkdtempSync(join(tmpdir(), `create-furin-${template}-`));
  const appPath = join(rootDir, `${template}-app`);
  createdDirs.push(rootDir);

  const result = runCommand(
    ["bun", CLI_ENTRY, appPath, "--template", template, "--yes"],
    process.cwd()
  );
  expect(result.exitCode).toBe(0);

  return appPath;
}

async function fetchRenderedHome(appPath: string, port: number): Promise<string> {
  const proc = Bun.spawn(["bun", "run", "dev"], {
    cwd: appPath,
    env: {
      ...process.env,
      PORT: String(port),
    },
    stderr: "pipe",
    stdout: "pipe",
  });

  runningServers.push({ kill: () => proc.kill() });

  await waitForServer(`http://127.0.0.1:${port}/`);
  const response = await fetch(`http://127.0.0.1:${port}/`);
  return response.text();
}

async function waitForServer(url: string): Promise<void> {
  const start = Date.now();

  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // server still booting
    }

    if (Date.now() - start > 20_000) {
      throw new Error(`Timed out waiting for ${url}`);
    }

    await Bun.sleep(200);
  }
}

function runCommand(
  command: string[],
  cwd: string
): { exitCode: number; stderr: string; stdout: string } {
  const proc = Bun.spawnSync(command, {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });

  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

function assertSuccess(result: { exitCode: number; stderr: string; stdout: string }): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed with exit code ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  }
}
