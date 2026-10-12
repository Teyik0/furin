import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const failure of [true, false]) {
  test(`the managed host uses one SDK and drains on ${failure ? "setup failure" : "native quit"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "furin-run-host-"));
    try {
      await mkdir(join(root, "bun"));
      await mkdir(join(root, "furin"));
      await writeFile(
        join(root, "bun/furin-host.json"),
        JSON.stringify({
          app: { identifier: "local.furin.host" },
        })
      );
      await writeFile(
        join(root, "furin/app.js"),
        `
      import { Elysia } from ${JSON.stringify(Bun.resolveSync("elysia", import.meta.dir))};
      import { desktopApp } from ${JSON.stringify(join(import.meta.dir, "../src/server.ts"))};
      import { appendFileSync } from "node:fs";
      export default new Elysia().use(desktopApp({
        onStartup() { appendFileSync(${JSON.stringify(join(root, "lifecycle"))}, "start\\n"); },
        onShutdown() { appendFileSync(${JSON.stringify(join(root, "lifecycle"))}, "stop\\n"); }
      })).get("/", () => "ready");`
      );
      const runner = join(root, "bun/main.ts");
      await writeFile(
        runner,
        `
      import { runDesktopHost } from ${JSON.stringify(join(import.meta.dir, "../src/host.ts"))};
      const codes = [];
      const stopped = Promise.withResolvers();
      let beforeQuit;
      const sdk = {
        Utils: { paths: { appData: ${JSON.stringify(root)} }, quit(code) { codes.push(code); stopped.resolve(); } },
        default: { events: { on(name, handler) { beforeQuit = handler; } } }
      };
      let backend;
      try {
        await runDesktopHost(sdk, async (context) => {
          if (context.sdk !== sdk) throw new Error("SDK identity changed");
          const started = await context.startBackend();
          backend = started.backend;
          if ((await fetch(backend.origin)).status !== 403) throw new Error("Missing guard");
          if (await (await fetch(backend.origin, {headers:{cookie:backend.cookie}})).text() !== "ready")
            throw new Error("Application not ready");
          if (${failure}) throw new Error("Native setup failed");
        });
        if (${failure}) throw new Error("Expected native failure");
        beforeQuit({ response: { allow: false } });
        if ((await fetch(backend.origin, {headers:{cookie:backend.cookie}})).status !== 200)
          throw new Error("Native veto ignored");
        beforeQuit({});
        await stopped.promise;
        if (JSON.stringify(codes) !== "[0]") throw new Error("Wrong successful quit");
        try { await fetch(backend.origin); throw new Error("Listener leaked"); }
        catch(error) { if (error.message === "Listener leaked") throw error; }
      } catch(error) {
        if (!${failure}) throw error;
        if (error.message !== "Native setup failed") throw error;
        if (JSON.stringify(codes) !== "[1]") throw new Error("Wrong quit status");
        try { await fetch(backend.origin); throw new Error("Listener leaked"); }
        catch(error) { if (error.message === "Listener leaked") throw error; }
      }`
      );
      const child = Bun.spawn([process.execPath, runner], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
        env: { ...process.env, FURIN_DESKTOP_DEV: "" },
      });
      const [status, diagnostic] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(status, diagnostic).toBe(0);
      expect(await Bun.file(join(root, "lifecycle")).text()).toBe("start\nstop\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
