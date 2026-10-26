import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ORIGIN = /http:\/\/127\.0\.0\.1:\d+/;
test.each([
  ["", true],
  ["--desktop", false],
] as const)(
  "furin dev %s delegates once to the optional desktop package",
  async (flag, openBrowser) => {
    const root = await mkdtemp(join(tmpdir(), "furin-dev-cli-"));
    try {
      await writeFile(join(root, "furin.config.ts"), "export default { desktop: {} };");
      const sdk = join(root, "node_modules/@teyik0/furin-electrobun");
      await mkdir(sdk, { recursive: true });
      await writeFile(
        join(sdk, "package.json"),
        '{"name":"@teyik0/furin-electrobun","type":"module","exports":{"./dev":"./dev.ts"}}'
      );
      await writeFile(
        join(sdk, "dev.ts"),
        `
        export async function runDesktopDevelopment(cwd, openBrowser) {
          await Bun.write(${JSON.stringify(join(root, "called.json"))}, JSON.stringify({ cwd, openBrowser }));
        }
      `
      );
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "../../src/cli/index.ts"),
          "dev",
          ...(flag ? [flag] : []),
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 5000 }
      );
      const [status, diagnostic] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(status, diagnostic).toBe(0);
      const actual: { cwd: string; openBrowser: boolean } = await Bun.file(
        join(root, "called.json")
      ).json();
      expect(await realpath(actual.cwd)).toBe(await realpath(root));
      expect(actual.openBrowser).toBe(openBrowser);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

test.each([
  { sourceListener: false, override: true },
  { sourceListener: true, override: true },
  { sourceListener: true, override: false },
])(
  "furin dev --web starts $sourceListener with override=$override and drains it without the SDK",
  async ({ sourceListener, override }) => {
    const root = await mkdtemp(join(tmpdir(), "furin-web-cli-"));
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const sourcePort = reservation.port;
    await reservation.stop(true);
    try {
      await writeFile(
        join(root, "furin.config.ts"),
        "export default { desktop: {}, serverEntry: 'server.ts' };"
      );
      await writeFile(
        join(root, "server.ts"),
        `
      import { Elysia } from ${JSON.stringify(Bun.resolveSync("elysia", import.meta.dir))};
      const app = new Elysia().get("/", () => "web-only").onStop(() =>
        Bun.write(${JSON.stringify(join(root, "closed"))}, "closed").then(() => undefined));
      export default app;
      ${sourceListener ? `app.get('/started', () => 'started').listen({hostname: '127.0.0.1', port: ${sourcePort}});` : ""}
    `
      );
      const runner = join(root, "runner.ts");
      await writeFile(
        runner,
        `process.on("message", () => process.emit("SIGINT"));
      process.argv = [process.execPath, "furin", "dev", "--web", ...${JSON.stringify(override ? ["--port", "0"] : [])}];
      await import(${JSON.stringify(resolve(import.meta.dir, "../../src/cli/index.ts"))});
      process.exit(0);`
      );
      child = Bun.spawn([process.execPath, runner], {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        ipc: () => undefined,
        timeout: 10_000,
        killSignal: "SIGKILL",
      });
      const reader = child.stdout.getReader();
      let text = "";
      let origin: string | undefined;
      const timer = setTimeout(() => child?.kill("SIGKILL"), 5000);
      try {
        while (!origin) {
          // biome-ignore lint/performance/noAwaitInLoops: Observe the public readiness line.
          const value = await reader.read();
          if (value.done) {
            throw new Error("Web development exited before readiness.");
          }
          text += new TextDecoder().decode(value.value);
          origin = text.match(ORIGIN)?.[0];
        }
      } finally {
        clearTimeout(timer);
        reader.releaseLock();
      }
      if (!override) {
        expect(new URL(origin).port).toBe(String(sourcePort));
      }
      expect(await (await fetch(origin)).text()).toBe("web-only");
      if (sourceListener) {
        expect(await (await fetch(`${origin}/started`)).text()).toBe("started");
      }
      if (process.platform === "win32") {
        child.send("stop");
      } else {
        child.kill("SIGINT");
      }
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
      expect(await Bun.file(join(root, "closed")).text()).toBe("closed");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await child?.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000
);

test("web development startup timeout is a failure and drains the partial application", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-web-timeout-"));
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    await writeFile(join(root, "furin.config.ts"), "export default { serverEntry: 'server.ts' };");
    await writeFile(
      join(root, "server.ts"),
      `import {Elysia} from ${JSON.stringify(Bun.resolveSync("elysia", import.meta.dir))};
      export default new Elysia()
        .onStop(() => Bun.write(${JSON.stringify(join(root, "closed"))}, "closed").then(() => undefined))
        .onStart(() => new Promise(() => {}));`
    );
    child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "../../src/cli/index.ts"), "dev", "--port", "0"],
      {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 38_000,
        killSignal: "SIGKILL",
      }
    );
    const [code, diagnostic] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, diagnostic).toBe(1);
    expect(diagnostic).toContain("Web development startup exceeded 30 seconds.");
    expect(await Bun.file(join(root, "closed")).text()).toBe("closed");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await child?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);

test("web hot replacement awaits source cleanup before reacquiring an exclusive resource", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-web-restart-"));
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    await writeFile(join(root, "furin.config.ts"), "export default {serverEntry:'server.ts'};");
    const source = (version: number) => `
      import { Elysia } from ${JSON.stringify(Bun.resolveSync("elysia", import.meta.dir))};
      import { mkdirSync, appendFileSync } from "node:fs";
      import { rm } from "node:fs/promises";
      const lock = ${JSON.stringify(join(root, "exclusive"))};
      mkdirSync(lock);
      appendFileSync(${JSON.stringify(join(root, "events"))}, "start${version}\\n");
      const app = new Elysia().get("/", () => "version${version}").onStop(async () => {
        await Bun.sleep(50);
        await rm(lock, {recursive:true});
        appendFileSync(${JSON.stringify(join(root, "events"))}, "stop${version}\\n");
      });
      export default app;
      app.listen({hostname:"127.0.0.1",port:0});
    `;
    await writeFile(join(root, "server.ts"), source(1));
    const runner = join(root, "runner.ts");
    await writeFile(
      runner,
      `
      process.on("message", () => process.emit("SIGINT"));
      process.argv = [process.execPath,"furin","dev","--web"];
      await import(${JSON.stringify(resolve(import.meta.dir, "../../src/cli/index.ts"))});
      process.exit(0);
    `
    );
    child = Bun.spawn([process.execPath, runner], {
      cwd: root,
      ipc: () => undefined,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 12_000,
      killSignal: "SIGKILL",
    });
    const reader = child.stdout.getReader();
    const ready = async () => {
      let output = "";
      let origin: string | undefined;
      while (!origin) {
        // biome-ignore lint/performance/noAwaitInLoops: Wait for the next hot-replacement readiness line.
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error(await new Response(child?.stderr).text());
        }
        output += new TextDecoder().decode(chunk.value);
        origin = output.match(ORIGIN)?.[0];
      }
      return origin;
    };
    const initial = await ready();
    expect(await (await fetch(initial)).text()).toBe("version1");
    await writeFile(join(root, "server.ts"), source(2));
    const replaced = await ready();
    expect(await (await fetch(replaced)).text()).toBe("version2");
    expect(await Bun.file(join(root, "events")).text()).toBe("start1\nstop1\nstart2\n");
    reader.releaseLock();
    child.send("stop");
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    expect(await Bun.file(join(root, "events")).text()).toBe("start1\nstop1\nstart2\nstop2\n");
  } finally {
    if (child?.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("source startup failure drains the app and returns a failure status", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-web-failure-"));
  try {
    await writeFile(join(root, "furin.config.ts"), "export default {serverEntry:'server.ts'};");
    await writeFile(
      join(root, "server.ts"),
      `
      import {Elysia} from ${JSON.stringify(Bun.resolveSync("elysia", import.meta.dir))};
      export default new Elysia().onStart(() => {throw new Error("source startup failure");})
        .onStop(() => Bun.write(${JSON.stringify(join(root, "closed"))},"closed").then(() => undefined));
    `
    );
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../../src/cli/index.ts"),
        "dev",
        "--web",
        "--port",
        "0",
      ],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 8000,
        killSignal: "SIGKILL",
      }
    );
    const [code, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(errors).toContain("source startup failure");
    expect(output).not.toContain("Web development:");
    expect(await Bun.file(join(root, "closed")).text()).toBe("closed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
