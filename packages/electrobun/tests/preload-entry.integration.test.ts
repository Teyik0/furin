import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSdk, sdkRunHeader } from "./fixtures/sdk";

test.each(["ready", "import", "startup", "listen"] as const)(
  "preload preserves the original %s error and cleanup before synchronous SDK quit(1)",
  async (stage) => {
    const root = await mkdtemp(join(tmpdir(), "furin-preload-error-"));
    let child: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
    try {
      await mkdir(join(root, "src"));
      await mkdir(join(root, "node_modules/@teyik0"), { recursive: true });
      await symlink(
        join(import.meta.dir, ".."),
        join(root, "node_modules/@teyik0/furin-electrobun"),
        "dir"
      );
      await writeFile(join(root, "package.json"), '{"version":"1.0.0"}');
      await writeFile(
        join(root, "bunfig.toml"),
        'preload = ["@teyik0/furin-electrobun/preload"]\n'
      );
      await writeFile(
        join(root, "furin.config.ts"),
        `export default {desktop:{
      app:{name:"Fixture",identifier:"local.furin.preload.error"},
      window:{width:800,height:600},dataDir:${JSON.stringify(join(root, "data"))}
    }};`
      );
      await writeFile(
        join(root, "src/server.ts"),
        `
      import { Elysia } from ${JSON.stringify(Bun.resolveSync("elysia", import.meta.dir))};
      import { desktopApp } from ${JSON.stringify(join(import.meta.dir, "../src/server.ts"))};
      import { appendFileSync } from "node:fs";
      new Elysia().use(desktopApp()).onStart(() => { ${stage === "startup" ? 'throw new Error("fixture original startup failure");' : ""} }).onStart(() => { ${stage === "ready" ? 'throw new Error("fixture original startup failure");' : ""} }).onStop(() => {
          console.error("fixture cleanup started");
          appendFileSync(${JSON.stringify(join(root, "stops"))}, "stop\\n");
        }).get("/", () => "private").listen({hostname:"127.0.0.1",port:0}, () => {
        ${stage === "listen" ? 'throw new Error("fixture original startup failure");' : ""}
      });
      ${stage === "import" ? 'throw new Error("fixture original startup failure");' : ""}
    `
      );
      await installSdk(root, "immediate-quit");
      await writeFile(join(root, "node_modules/electrobun/bin/electrobun.cjs"), sdkRunHeader(root));
      child = Bun.spawn([process.execPath, "--hot", "src/server.ts"], {
        cwd: root,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        timeout: 8000,
        killSignal: "SIGKILL",
      });
      const [code, diagnostic] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(code, diagnostic).toBe(1);
      expect(diagnostic).toContain("error: fixture original startup failure");
      expect(diagnostic).toContain("fixture cleanup started");
      expect(await Bun.file(join(root, "stops")).text()).toBe("stop\n");
      expect(await Bun.file(join(root, "quit")).text()).toBe("1");
      expect(await Bun.file(join(root, "window-url")).exists()).toBe(false);
      expect(await Bun.file(join(root, ".furin/electrobun/ready.json")).exists()).toBe(false);
    } finally {
      if (child?.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child?.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000
);
