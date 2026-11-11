import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { waitForFixture } from "./fixtures/standard-launch";

const ORIGIN = /Web development: (https?:\/\/127\.0\.0\.1:\d+)/;

test.each([
  { tls: false, opener: "exit" },
  { tls: true, opener: "exit" },
  { tls: false, opener: "held" },
  { tls: false, opener: "fail" },
])(
  "web CLI bootstraps an authenticated browser owner without native capabilities or admission bypass (TLS=$tls, opener=$opener)",
  async ({ tls, opener: mode }) => {
    const root = await mkdtemp(join(tmpdir(), "furin-web-owner-"));
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    const cert = await Bun.file(join(import.meta.dir, "fixtures/tls-cert.pem")).text();
    const key = await Bun.file(join(import.meta.dir, "fixtures/tls-key.pem")).text();
    const request = (input: string, options?: Parameters<typeof fetch>[1]) =>
      fetch(input, { ...options, tls: { ca: cert } });
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const sourcePort = reservation.port;
    await reservation.stop(true);
    try {
      await mkdir(join(root, "node_modules/@teyik0"), { recursive: true });
      await symlink(
        resolve(import.meta.dir, ".."),
        join(root, "node_modules/@teyik0/furin-electrobun"),
        "dir"
      );
      await writeFile(
        join(root, "furin.config.ts"),
        "export default {desktop:{},serverEntry:'server.ts'};"
      );
      // Capture the OS browser launch at the executable boundary, not the session verifier.
      let executable = "xdg-open";
      if (process.platform === "darwin") {
        executable = "open";
      } else if (process.platform === "win32") {
        executable = "rundll32.exe";
      }
      const opener = join(root, executable);
      if (process.platform === "win32") {
        const script = join(root, "opener.ts");
        await writeFile(
          script,
          `await Bun.write(${JSON.stringify(join(root, "browser-url"))}, process.argv.at(-1)!);
          ${mode === "fail" ? "console.error(process.argv.at(-1)); process.exit(23);" : ""}
          ${
            mode === "held"
              ? `
            await Bun.write(${JSON.stringify(join(root, "opener-pid"))},String(process.pid));
            while (!(await Bun.file(${JSON.stringify(join(root, "release-opener"))}).exists())) await Bun.sleep(20);
            await Bun.write(${JSON.stringify(join(root, "opener-closed"))},"closed");
          `
              : ""
          }`
        );
        const built = await Bun.build({ entrypoints: [script], compile: { outfile: opener } });
        if (!built.success) {
          throw new AggregateError(built.logs, "Browser fixture compilation failed");
        }
      } else {
        await writeFile(
          opener,
          `#!/bin/sh
          printf '%s' "$1" > '${join(root, "browser-url")}'
          ${mode === "fail" ? 'printf "%s" "$1" >&2; exit 23' : ""}
          ${
            mode === "held"
              ? `
            printf '%s' "$$" > '${join(root, "opener-pid")}'
            while [ ! -f '${join(root, "release-opener")}' ]; do sleep 0.02; done
            printf closed > '${join(root, "opener-closed")}'
          `
              : ""
          }
        `
        );
        await chmod(opener, 0o755);
      }
      await writeFile(
        join(root, "server.ts"),
        `
      import { Elysia } from ${JSON.stringify(Bun.resolveSync("elysia", import.meta.dir))};
      import { desktopApp } from ${JSON.stringify(resolve(import.meta.dir, "../src/server.ts"))};
      const callers = new WeakMap();
      import {appendFileSync} from "node:fs";
      const app = new Elysia().wrap((next) => (request,...rest) => {
        appendFileSync(${JSON.stringify(join(root, "access-log"))}, new URL(request.url).pathname + "\\n");
        return next(request,...rest);
      }).use(desktopApp({
        admission(request, context) {
          if (context.desktopSession) {callers.set(request, context); return;}
          if (request.headers.get("authorization") === "Bearer paired-remote") {
            callers.set(request, context); return;
          }
          return new Response("missing-session", {status:403});
        }
      })).get("/api/session", async ({request, desktop}) => ({
        eden: await (await app.handle(new Request("http://localhost/eden"))).text(),
        owner: callers.get(request)?.desktopSession === true,
        desktopHost: callers.get(request)?.desktopHost ?? false,
        hostNative: desktop !== null,
      })).get("/eden", () => "in-process");
      export default app;
      app.listen({hostname:"127.0.0.1",port:3030,tls:${JSON.stringify(tls ? { cert, key } : undefined)}});
    `
      );
      const runner = join(root, "runner.ts");
      await writeFile(
        runner,
        `
        process.on("message", () => process.emit("SIGINT"));
        process.argv = [process.execPath,"furin","dev","--web","--port",${JSON.stringify(String(sourcePort))}];
        await import(${JSON.stringify(resolve(import.meta.dir, "../../core/src/cli/index.ts"))});
        process.exit(0);
      `
      );
      child = Bun.spawn([process.execPath, runner], {
        cwd: root,
        env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH}` },
        ipc: () => undefined,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 12_000,
        killSignal: "SIGKILL",
      });
      if (mode === "fail") {
        const [code, output, errors] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        const url = await Bun.file(join(root, "browser-url")).text();
        expect(code).toBe(1);
        expect(errors).toContain(
          "Could not open the web development owner session in the system browser."
        );
        expect(errors).not.toContain(new URL(url).pathname);
        expect(output).not.toContain(new URL(url).pathname);
        expect(output).not.toContain("Web development:");
        return;
      }
      const reader = child.stdout.getReader();
      let output = "";
      let origin: string | undefined;
      // Cancel through the real worker before the existing subprocess deadline on failure.
      const startup = setTimeout(() => child?.send("stop"), 8000);
      try {
        while (!origin) {
          // biome-ignore lint/performance/noAwaitInLoops: Observe readiness from the real CLI.
          const chunk = await reader.read();
          if (chunk.done) {
            throw new Error(await new Response(child.stderr).text());
          }
          output += new TextDecoder().decode(chunk.value);
          origin = output.match(ORIGIN)?.[1];
        }
      } finally {
        clearTimeout(startup);
        reader.releaseLock();
      }
      if (mode === "held") {
        const pid = Number(await Bun.file(join(root, "opener-pid")).text());
        expect(() => process.kill(pid, 0)).not.toThrow();
        expect(await Bun.file(join(root, "opener-closed")).exists()).toBe(false);
      }
      expect((await request(`${origin}/api/session`)).status).toBe(403);
      for (const cookie of ["", "furin_web_dev=invalid"]) {
        // biome-ignore lint/performance/noAwaitInLoops: Exercise application-owned remote authentication.
        const remote = await request(`${origin}/api/session`, {
          headers: {
            authorization: "Bearer paired-remote",
            cookie,
            "x-forwarded-for": "100.64.0.1",
          },
        });
        expect(await remote.json()).toEqual({
          owner: false,
          desktopHost: false,
          hostNative: false,
          eden: "in-process",
        });
      }
      const url = await Bun.file(join(root, "browser-url")).text();
      expect(output).not.toContain(new URL(url).pathname);
      expect(output).not.toContain("furin_web_dev");
      const bootstrapOrigin = new URL(url).origin;
      expect((await request(`${bootstrapOrigin}/.furin/dev-owner/no-token`)).status).toBe(403);
      expect((await request(url, { headers: { origin: "https://evil.test" } })).status).toBe(403);
      expect((await request(url, { headers: { "x-forwarded-for": "127.0.0.1" } })).status).toBe(
        403
      );
      const response = await request(url, { redirect: "manual" });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`${origin}/`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const cookie = response.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("HttpOnly; SameSite=Strict; Path=/");
      expect(cookie).not.toContain("Domain=");
      expect(cookie.includes("; Secure")).toBe(tls);
      expect((await request(url, { redirect: "manual" })).status).toBe(410);
      const headers = { cookie: cookie.split(";")[0] ?? "" };
      expect(await (await request(`${origin}/api/session`, { headers })).json()).toEqual({
        owner: true,
        desktopHost: false,
        hostNative: false,
        eden: "in-process",
      });
      for (const [name, value] of [
        ["origin", "https://evil.test"],
        ["sec-fetch-site", "cross-site"],
        ["referer", "https://evil.test/"],
        ["x-forwarded-for", "127.0.0.1"],
        ["forwarded", "for=127.0.0.1"],
        ["cookie", "furin_web_dev=forged"],
      ] as const) {
        const forged = new Headers(headers);
        forged.set(name, value);
        // biome-ignore lint/performance/noAwaitInLoops: Exercise each network admission rejection.
        const denied = await request(`${origin}/api/session`, { headers: forged });
        expect(denied.status).toBe(403);
      }
      expect(await Bun.file(join(root, "access-log")).text()).not.toContain(new URL(url).pathname);
      const sourcePath = join(root, "server.ts");
      await writeFile(
        sourcePath,
        (await Bun.file(sourcePath).text()).replace('"in-process"', '"after-reload"')
      );
      const replacement = child.stdout.getReader();
      let reloadOutput = "";
      while (!ORIGIN.test(reloadOutput)) {
        // biome-ignore lint/performance/noAwaitInLoops: Observe completion of the real hot replacement.
        const chunk = await replacement.read();
        if (chunk.done) {
          throw new Error("Worker exited during hot replacement");
        }
        reloadOutput += new TextDecoder().decode(chunk.value);
      }
      replacement.releaseLock();
      expect(await (await request(`${origin}/api/session`, { headers })).json()).toEqual({
        owner: true,
        desktopHost: false,
        hostNative: false,
        eden: "after-reload",
      });
      expect(await Bun.file(join(root, "browser-url")).text()).toBe(url);
      expect(reloadOutput).not.toContain(new URL(url).pathname);
      child.send("stop");
      const errors = await new Response(child.stderr).text();
      expect(await child.exited, errors).toBe(0);
      expect(errors).not.toContain(new URL(url).pathname);
      if (mode === "held") {
        const pid = Number(await Bun.file(join(root, "opener-pid")).text());
        expect(() => process.kill(pid, 0)).not.toThrow();
        expect(await Bun.file(join(root, "opener-closed")).exists()).toBe(false);
      }
      expect(
        await request(url).then(
          () => false,
          () => true
        )
      ).toBe(true);
    } finally {
      if (mode === "held") {
        await writeFile(join(root, "release-opener"), "release");
        if (await Bun.file(join(root, "opener-pid")).exists()) {
          const pid = Number(await Bun.file(join(root, "opener-pid")).text());
          await waitForFixture(async () => {
            if (!(await Bun.file(join(root, "opener-closed")).exists())) {
              return false;
            }
            try {
              process.kill(pid, 0);
              return false;
            } catch {
              return true;
            }
          }, Boolean);
          expect(await Bun.file(join(root, "opener-closed")).exists()).toBe(true);
        }
      }
      if (child?.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child?.exited;
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
  15_000
);
