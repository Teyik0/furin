// biome-ignore-all lint/performance/noAwaitInLoops: Observe helper readiness before signalling it.
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDesktop } from "../src/prepare";

for (const scenario of [
  { signal: "SIGINT", failure: "", code: 0, diagnostic: "" },
  { signal: "SIGTERM", failure: "", code: 0, diagnostic: "" },
  {
    signal: "SIGTERM",
    failure: 'throw new Error("cleanup failed");',
    code: 1,
    diagnostic: "cleanup failed",
  },
  {
    signal: "SIGINT",
    failure: "setInterval(() => {}, 1000); await new Promise(() => {});",
    code: 1,
    diagnostic: "5 seconds",
  },
] as const) {
  test(`dev helper drains once on ${scenario.signal}: ${scenario.diagnostic || "success"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "furin-dev-signal-"));
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    try {
      const entry = join(root, "server.ts");
      await writeFile(
        entry,
        `import { appendFileSync } from "node:fs";
import { createDesktopApp } from ${JSON.stringify(Bun.resolveSync("@teyik0/furin-electrobun/server", import.meta.dir))};
export default createDesktopApp().get("/", () => "ready");
export async function onShutdown() {
  appendFileSync(${JSON.stringify(join(root, "stopped"))}, "stop\\n");
  await Bun.sleep(300);
  ${scenario.failure}
}`
      );
      const generated = await prepareDesktop(
        root,
        {
          app: { name: "Fixture", identifier: "local.furin.fixture", version: "1.0.0" },
          window: { width: 800, height: 600 },
          dataDir: join(root, "data"),
        },
        { mode: "dev", root, serverEntry: entry }
      );
      child = Bun.spawn([process.execPath, join(generated, "dev-server.ts")], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const readyPath = join(generated, "ready.json");
      const deadline = Date.now() + 3000;
      while (!(await Bun.file(readyPath).exists())) {
        if (child.exitCode !== null || Date.now() > deadline) {
          throw new Error("Dev helper failed to become ready.");
        }
        await Bun.sleep(10);
      }
      const ready: { url: string } = await Bun.file(readyPath).json();
      child.kill(scenario.signal);
      await writeFile(join(generated, "control"), "stop");
      expect(await Promise.race([child.exited, Bun.sleep(6500).then(() => "hung")])).toBe(
        scenario.code
      );
      expect(await Bun.file(join(root, "stopped")).text()).toBe("stop\n");
      expect(await new Response(child.stdout).text()).not.toContain(ready.url);
      const diagnostic = await new Response(child.stderr).text();
      if (scenario.code) {
        expect(diagnostic).toContain("Dev shutdown failed");
        expect(diagnostic).toContain(scenario.diagnostic);
      } else {
        expect(diagnostic).toBe("");
      }
    } finally {
      if (child?.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 9000);
}
