import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDesktop } from "../src/prepare";
import { installSdk } from "./fixtures/sdk";

test("SDK failure drains the built app once and quits(1)", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-startup-"));
  let child: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
  try {
    const artifact = join(root, ".furin/build/bun");
    await mkdir(artifact, { recursive: true });
    const entry = join(artifact, "app.js");
    await writeFile(
      entry,
      `import { appendFileSync } from "node:fs";
import { createDesktopApp } from ${JSON.stringify(Bun.resolveSync("@teyik0/furin-electrobun/server", import.meta.dir))};
export default createDesktopApp().get("/", () => "ready").onStop(() => { appendFileSync(${JSON.stringify(join(root, "stopped"))}, "stop\\n"); });
`
    );
    const generated = await prepareDesktop(
      root,
      {
        app: { name: "Fixture", identifier: "local.furin.fixture", version: "1.0.0" },
        dataDir: join(root, "data"),
      },
      { mode: "build", root, serverEntry: entry }
    );
    await installSdk(root, "failed-window");
    const bundle = join(root, "bundle/app");
    await cp(join(generated, "furin"), join(bundle, "furin"), { recursive: true });
    const built = await Bun.build({
      entrypoints: [join(generated, "main.ts")],
      target: "bun",
      format: "esm",
      outdir: join(bundle, "bun"),
      naming: "index.js",
    });
    expect(built.success).toBe(true);
    await cp(join(generated, "host.json"), join(bundle, "bun/furin-host.json"));
    child = Bun.spawn([process.execPath, join(bundle, "bun/index.js")], {
      env: process.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await Promise.race([child.exited, Bun.sleep(6500).then(() => "hung")])).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("constructor failed");
    expect(await Bun.file(join(root, "stopped")).text()).toBe("stop\n");
    expect(await Bun.file(join(root, "quit")).text()).toBe("1");
  } finally {
    if (child?.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 9000);
