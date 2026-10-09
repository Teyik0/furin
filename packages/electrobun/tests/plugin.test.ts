import { expect, expectTypeOf, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { startDesktopBackend } from "../src/runtime";
import { desktopApp } from "../src/server";

test("desktopApp protects the original typed Elysia root before application wrappers", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-desktop-plugin-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const root = new Elysia({ prefix: "/api" }).decorate("answer", 42);
  const app = root
    .use(desktopApp({ restrictWebToLoopback: false }))
    .wrap(
      (next) =>
        (request, ...rest: unknown[]) =>
          new URL(request.url).pathname === "/early"
            ? new Response("shortcut")
            : next(request, ...rest)
    )
    .get("/item/:id", ({ params, answer }) => {
      expectTypeOf(params.id).toEqualTypeOf<string>();
      expectTypeOf(answer).toEqualTypeOf<number>();
      return { id: params.id, answer };
    });
  let backend: Awaited<ReturnType<typeof startDesktopBackend>> | undefined;
  try {
    expect(Object.is(app, root)).toBe(true);
    backend = await startDesktopBackend(() => Promise.resolve({ default: app }), data, "build");
    expect((await fetch(`${backend.origin}/early`)).status).toBe(403);
    expect((await fetch(`${backend.origin}/api/item/7`)).status).toBe(403);
    expect(
      await (
        await fetch(`${backend.origin}/api/item/7`, { headers: { cookie: backend.cookie } })
      ).json()
    ).toEqual({ id: "7", answer: 42 });
  } finally {
    try {
      await backend?.stop();
    } finally {
      if (previousData === undefined) {
        delete process.env.FURIN_APP_DATA_DIR;
      } else {
        process.env.FURIN_APP_DATA_DIR = previousData;
      }
      await rm(data, { recursive: true, force: true });
    }
  }
});

for (const mode of ["web", "desktop"] as const) {
  test(`plugin lifecycle initializes and drains once in ${mode}`, async () => {
    const data = await mkdtemp(join(tmpdir(), "furin-plugin-lifecycle-"));
    const previousData = process.env.FURIN_APP_DATA_DIR;
    let starts = 0;
    let stops = 0;
    let ready = false;
    const app = new Elysia()
      .use(
        desktopApp({
          async onStartup(signal) {
            expect(signal.aborted).toBe(false);
            starts += 1;
            await Bun.sleep(10);
            ready = true;
          },
          onShutdown() {
            stops += 1;
          },
        })
      )
      .get("/", () => (ready ? "ready" : "cold"));
    let backend: Awaited<ReturnType<typeof startDesktopBackend>> | undefined;
    try {
      let origin: string;
      let cookie: string | undefined;
      if (mode === "desktop") {
        backend = await startDesktopBackend(() => Promise.resolve({ default: app }), data, "build");
        ({ origin, cookie } = backend);
      } else {
        await new Promise<void>((resolve) => {
          app.listen({ hostname: "127.0.0.1", port: 0 }, () => resolve());
        });
        origin = `http://127.0.0.1:${app.server?.port}`;
      }
      expect(await (await fetch(origin, { headers: cookie ? { cookie } : {} })).text()).toBe(
        "ready"
      );
      expect(starts).toBe(1);
      await (backend?.stop() ?? app.stop(true));
      await (backend?.stop() ?? app.stop(true));
      expect(stops).toBe(1);
    } finally {
      try {
        await (backend?.stop() ?? app.stop(true));
      } finally {
        if (previousData === undefined) {
          delete process.env.FURIN_APP_DATA_DIR;
        } else {
          process.env.FURIN_APP_DATA_DIR = previousData;
        }
        await rm(data, { recursive: true, force: true });
      }
    }
  });
}

test("optional web protection rejects foreign hosts and mutation origins before shortcuts", async () => {
  const app = new Elysia()
    .use(desktopApp({ restrictWebToLoopback: true }))
    .wrap(() => () => new Response("shortcut"));
  const responses = await Promise.all(
    [
      new Request("http://foreign.test/api"),
      new Request("http://localhost/api", {
        method: "POST",
        headers: { origin: "https://foreign.test" },
      }),
    ].map((request) => app.handle(request))
  );
  for (const response of responses) {
    expect(response.status).toBe(403);
  }
  expect(await (await app.handle("http://localhost/api")).text()).toBe("shortcut");
  expect(
    (
      await app.handle(
        new Request("http://127.0.0.1/api", {
          method: "POST",
          headers: { origin: "http://127.0.0.1" },
        })
      )
    ).status
  ).toBe(200);
  const ordinary = new Elysia().use(desktopApp()).get("/", () => "web");
  expect((await ordinary.handle("https://ordinary.test/")).status).toBe(200);
});

test("installing the desktop plugin after a wrapper is rejected", () => {
  expect(() => new Elysia().wrap(() => () => new Response("bypass")).use(desktopApp())).toThrow(
    "before application wrappers"
  );
});

test("plugin startup failure cleans resources once before any listener opens", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-plugin-failure-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  let signal: AbortSignal | undefined;
  let stops = 0;
  const app = new Elysia().use(
    desktopApp({
      onStartup(value) {
        signal = value;
        throw new Error("Initialization failed");
      },
      onShutdown() {
        stops += 1;
      },
    })
  );
  try {
    await expect(
      startDesktopBackend(() => Promise.resolve({ default: app }), data, "build")
    ).rejects.toThrow("Initialization failed");
    expect(stops).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(app.server).toBeUndefined();
  } finally {
    if (previousData === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previousData;
    }
    await rm(data, { recursive: true, force: true });
  }
});

test("web restriction fails closed for a non-loopback listener", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-web-bind-"));
  try {
    const entry = join(root, "main.ts");
    await writeFile(
      entry,
      `
      import { Elysia } from ${JSON.stringify(Bun.resolveSync("elysia", import.meta.dir))};
      import { desktopApp } from ${JSON.stringify(join(import.meta.dir, "../src/server.ts"))};
      new Elysia().use(desktopApp({
        restrictWebToLoopback: true,
        onStartup() { throw new Error("Initialization must not run"); }
      })).get("/", () => "private").listen({hostname:"0.0.0.0",port:0});
    `
    );
    const child = Bun.spawn([process.execPath, entry], {
      stdout: "ignore",
      stderr: "pipe",
      timeout: 5000,
    });
    const [status, diagnostic] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(status, diagnostic).toBe(1);
    expect(diagnostic).toContain("loopback listener hostname");
    expect(diagnostic).not.toContain("Initialization must not run");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
