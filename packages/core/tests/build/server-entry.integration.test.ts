import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createTmpApp } from "../support/app-fixtures.ts";
import { runCli, runProcess } from "../support/process.ts";

test("the production web server uses the source listen port in its own process", async () => {
  const fixture = createTmpApp("cli-app");
  try {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const { port } = probe;
    await probe.stop(true);
    appendFileSync(
      join(fixture.path, "src/server.ts"),
      `\napp.get("/api/pid", () => String(process.pid))
        .listen({ hostname: "127.0.0.1", port: ${port} });\n`
    );
    const built = await runCli(["build", "--target", "bun"], { cwd: fixture.path });
    expect(built.exitCode, built.stderr + built.stdout).toBe(0);
    const launched = await runProcess(
      [
        process.execPath,
        "--eval",
        `await import("./.furin/build/bun/server.js");
        const response = await fetch("http://127.0.0.1:${port}/api/pid");
        if (!response.ok || await response.text() !== String(process.pid)) {
          throw new Error("The source listener must serve requests in this process");
        }
        console.log("source listener preserved");
        process.exit(0);`,
      ],
      { cwd: fixture.path, env: { PORT: undefined }, timeoutMs: 10_000 }
    );
    expect(launched.exitCode, launched.stderr + launched.stdout).toBe(0);
    expect(launched.stdout).toContain("source listener preserved");
  } finally {
    fixture.cleanup();
  }
}, 30_000);
