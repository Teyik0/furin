import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { websocket } from "elysia/websocket";
import { startDesktopBackend } from "../src/runtime";
import { createDesktopApp } from "../src/server";

for (const mode of ["web", "desktop"] as const) {
  test(`factory preserves public wrapper arguments for ${mode} requests`, async () => {
    const data = await mkdtemp(join(tmpdir(), "furin-wrap-arguments-"));
    const previousData = process.env.FURIN_APP_DATA_DIR;
    let received: unknown;
    const app = createDesktopApp()
      .wrap((next) => (request, ...rest: unknown[]) => {
        [received] = rest;
        return next(request, ...rest);
      })
      .get("/", () => "ok");
    let backend: Awaited<ReturnType<typeof startDesktopBackend>> | undefined;
    try {
      let origin: string;
      const headers: { cookie?: string } = {};
      if (mode === "desktop") {
        backend = await startDesktopBackend(() => Promise.resolve({ default: app }), data, "build");
        ({ origin } = backend);
        const bootstrap = await fetch(backend.url, { redirect: "manual" });
        const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
        if (!cookie) {
          throw new Error("Missing desktop cookie.");
        }
        headers.cookie = cookie;
      } else {
        await new Promise<void>((resolve) => {
          app.listen({ hostname: "127.0.0.1", port: 0 }, () => resolve());
        });
        origin = `http://127.0.0.1:${app.server?.port}`;
      }
      expect(await (await fetch(origin, { headers })).text()).toBe("ok");
      expect(received === app.server).toBe(true);
    } finally {
      if (backend) {
        await backend.stop();
      } else {
        await app.stop(true);
      }
      if (previousData === undefined) {
        delete process.env.FURIN_APP_DATA_DIR;
      } else {
        process.env.FURIN_APP_DATA_DIR = previousData;
      }
      await rm(data, { recursive: true, force: true });
    }
  });
}

test("factory guard precedes a source request short circuit", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-factory-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const app = createDesktopApp()
    .request(({ request }) =>
      new URL(request.url).pathname === "/early"
        ? new Response("source", { status: 201 })
        : undefined
    )
    .get("/", () => "normal");
  const backend = await startDesktopBackend(() => Promise.resolve({ default: app }), data, "build");
  try {
    expect((await fetch(`${backend.origin}/early`)).status).toBe(403);
    const bootstrap = await fetch(backend.url, { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Missing desktop cookie.");
    }
    expect((await fetch(`${backend.origin}/early`, { headers: { cookie } })).status).toBe(201);
    expect(await (await fetch(backend.origin, { headers: { cookie } })).text()).toBe("normal");
  } finally {
    await backend.stop();
    if (previousData === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previousData;
    }
    await rm(data, { recursive: true, force: true });
  }
});

for (const kind of ["wrap", "plugin"] as const) {
  test(`factory guard precedes a source ${kind} wrapper`, async () => {
    const data = await mkdtemp(join(tmpdir(), "furin-wrapper-"));
    const previousData = process.env.FURIN_APP_DATA_DIR;
    const root = createDesktopApp();
    const wrapped = kind === "wrap" ? root : new Elysia();
    wrapped.wrap(
      (next) => (request) =>
        new URL(request.url).pathname === "/early"
          ? new Response("wrapped", { status: 202 })
          : next(request)
    );
    const app = (kind === "plugin" ? root.use(wrapped) : root).get("/", () => "normal");
    const backend = await startDesktopBackend(
      () => Promise.resolve({ default: app }),
      data,
      "build"
    );
    try {
      expect((await fetch(`${backend.origin}/early`)).status).toBe(403);
      const bootstrap = await fetch(backend.url, { redirect: "manual" });
      const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
      if (!cookie) {
        throw new Error("Missing desktop cookie.");
      }
      expect((await fetch(`${backend.origin}/early`, { headers: { cookie } })).status).toBe(202);
    } finally {
      await backend.stop();
      if (previousData === undefined) {
        delete process.env.FURIN_APP_DATA_DIR;
      } else {
        process.env.FURIN_APP_DATA_DIR = previousData;
      }
      await rm(data, { recursive: true, force: true });
    }
  });
}

test("ordinary web use stays inactive and preserves Elysia prefix and decorator inference", async () => {
  const app = createDesktopApp({ prefix: "/api", as: "global" })
    .decorate("answer", 42)
    .get("/item/:id", ({ params, answer }) => {
      const id: string = params.id;
      const value: number = answer;
      return { id, value };
    });
  expect(await (await app.handle("http://web.test/api/item/7")).json()).toEqual({
    id: "7",
    value: 42,
  });
});

test("unbranded roots fail before listen and clean source-owned resources", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-unbranded-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const app = new Elysia().get("/", () => "plain");
  let closed = false;
  try {
    await expect(
      startDesktopBackend(
        () =>
          Promise.resolve({
            default: app,
            onShutdown: () => {
              closed = true;
            },
          }),
        data,
        "build"
      )
    ).rejects.toThrow("@teyik0/furin-electrobun/server");
    expect(app.server).toBeUndefined();
    expect(closed).toBe(true);
  } finally {
    if (previousData === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previousData;
    }
    await rm(data, { recursive: true, force: true });
  }
});

test("guard is already active for requests queued during async setup", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-setup-gate-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let cleaned = false;
  const app = createDesktopApp()
    .request(() => new Response("source", { status: 201 }))
    .setup(async () => {
      entered.resolve();
      await release.promise;
    })
    .cleanup(() => {
      cleaned = true;
    });
  let ready = false;
  const startup = startDesktopBackend(() => Promise.resolve({ default: app }), data, "build").then(
    (backend) => {
      ready = true;
      return backend;
    }
  );
  try {
    await entered.promise;
    expect(ready).toBe(false);
    const { server } = app;
    expect(server).toBeDefined();
    if (!server) {
      throw new Error("Setup must run with an actual listening server.");
    }
    expect(server.port).toBeGreaterThan(0);
    const queued = fetch(`http://127.0.0.1:${server.port}/early`);
    const deadline = Date.now() + 3000;
    while (server.pendingRequests < 1 && Date.now() < deadline) {
      // biome-ignore lint/performance/noAwaitInLoops: observe the public listener accepting traffic
      await Bun.sleep(1);
    }
    expect(server.pendingRequests).toBe(1);
    release.resolve();
    const backend = await startup;
    expect((await queued).status).toBe(403);
    const bootstrap = await fetch(backend.url, { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Missing desktop cookie.");
    }
    expect((await fetch(backend.origin, { headers: { cookie } })).status).toBe(201);
    await backend.stop();
    expect(cleaned).toBe(true);
  } finally {
    release.resolve();
    await (await startup).stop();
    if (previousData === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previousData;
    }
    await rm(data, { recursive: true, force: true });
  }
});

test("application WebSocket upgrades require the activated instance session", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-ws-gate-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  let opens = 0;
  const app = createDesktopApp()
    .use(websocket())
    .ws("/ws", {
      open(socket) {
        opens += 1;
        socket.send("ready");
      },
    });
  const backend = await startDesktopBackend(() => Promise.resolve({ default: app }), data, "build");
  try {
    const url = `${backend.origin.replace("http:", "ws:")}/ws`;
    const denied = new WebSocket(url);
    const rejected = Promise.withResolvers<string>();
    denied.onerror = () => {
      rejected.resolve("rejected");
    };
    denied.onopen = () => {
      rejected.resolve("opened");
      denied.close();
    };
    expect(await rejected.promise).toBe("rejected");
    expect(opens).toBe(0);
    const bootstrap = await fetch(backend.url, { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Missing desktop cookie.");
    }
    const socket = new WebSocket(url, { headers: { cookie, origin: backend.origin } });
    const message = Promise.withResolvers<unknown>();
    socket.onmessage = (event) => {
      message.resolve(event.data);
      socket.close();
    };
    socket.onerror = () => {
      message.reject(new Error("Authenticated upgrade failed."));
    };
    expect(await message.promise).toBe("ready");
    expect(opens).toBe(1);
  } finally {
    await backend.stop();
    if (previousData === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previousData;
    }
    await rm(data, { recursive: true, force: true });
  }
});
