import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { startDesktopBackend } from "../src/runtime";
import { createDesktopApp } from "../src/server";

test("in-process Elysia owns one ephemeral listener, session and shutdown", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-data-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  let shutdowns = 0;
  let importedData: string | undefined;
  const app = createDesktopApp()
    .get("/", () => "SSR")
    .get("/api/resource", () => ({ resource: "unchanged" }));
  let backend: Awaited<ReturnType<typeof startDesktopBackend>> | undefined;
  try {
    backend = await startDesktopBackend(
      () => {
        importedData = process.env.FURIN_APP_DATA_DIR;
        return Promise.resolve({
          default: app,
          onShutdown: () => {
            shutdowns += 1;
          },
        });
      },
      data,
      "build"
    );
    expect(importedData).toBe(data);
    expect(app.server?.port).toBeGreaterThan(0);
    expect(backend.origin).toStartWith("http://127.0.0.1:");
    expect((await fetch(`${backend.origin}/api/resource`)).status).toBe(403);
    const bootstrap = await fetch(backend.url, { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Bootstrap did not set the desktop cookie.");
    }
    expect(await (await fetch(`${backend.origin}/`, { headers: { cookie } })).text()).toBe("SSR");
    expect(
      await (await fetch(`${backend.origin}/api/resource`, { headers: { cookie } })).json()
    ).toEqual({ resource: "unchanged" });
    await Promise.all([backend.stop(), backend.stop()]);
    expect(shutdowns).toBe(1);
    expect(app.server).toBeUndefined();
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

test("desktop rejects and cleans a server that booted during import", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-data-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const app = new Elysia().get("/", () => "web").listen({ hostname: "127.0.0.1", port: 0 });
  let shutdowns = 0;
  try {
    await expect(
      startDesktopBackend(
        () =>
          Promise.resolve({
            default: app,
            onShutdown: () => {
              shutdowns += 1;
            },
          }),
        data,
        "build"
      )
    ).rejects.toThrow("import.meta.main");
    expect(app.server).toBeUndefined();
    expect(shutdowns).toBe(1);
  } finally {
    await app.stop(true);
    if (previousData === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previousData;
    }
    await rm(data, { recursive: true, force: true });
  }
});

test("shutdown rejects after five seconds when a resource cleanup hangs", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-shutdown-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const app = createDesktopApp().get("/", () => "ready");
  const handle = setInterval(() => {
    /* Keep a resource handle alive during the hung cleanup. */
  }, 1000);
  let shutdowns = 0;
  try {
    const backend = await startDesktopBackend(
      () =>
        Promise.resolve({
          default: app,
          onShutdown: () => {
            shutdowns += 1;
            return new Promise<void>(() => {
              /* Deliberately never settles. */
            });
          },
        }),
      data,
      "build"
    );
    const stopped = backend.stop();
    const outcome = await Promise.race([
      stopped.then(
        () => "unexpected success",
        (error: Error) => error.message
      ),
      Bun.sleep(6000).then(() => "shutdown never settled"),
    ]);
    expect(outcome).toContain("5 seconds");
    expect(backend.stop()).toBe(stopped);
    expect(shutdowns).toBe(1);
    expect(app.server).toBeUndefined();
  } finally {
    clearInterval(handle);
    await app.stop(true);
    if (previousData === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previousData;
    }
    await rm(data, { recursive: true, force: true });
  }
}, 8000);

test("callback readiness times out after thirty seconds and closes the listener and module", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-startup-timeout-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const entered = Promise.withResolvers<void>();
  let shutdowns = 0;
  const handle = setInterval(() => {
    /* Resource owned by the imported module. */
  }, 1000);
  const app = createDesktopApp().setup(() => {
    entered.resolve();
    return new Promise<void>(() => {
      /* Never reaches the listen callback. */
    });
  });
  const startup = startDesktopBackend(
    () =>
      Promise.resolve({
        default: app,
        onShutdown: () => {
          shutdowns += 1;
          clearInterval(handle);
        },
      }),
    data,
    "build"
  );
  const observed = startup.then(
    () => "unexpected readiness",
    (error: Error) => error.message
  );
  try {
    await entered.promise;
    const outcome = await Promise.race([
      observed,
      Bun.sleep(31_000).then(() => "startup never settled"),
    ]);
    expect(outcome).toContain("30 seconds");
    expect(shutdowns).toBe(1);
    expect(app.server).toBeUndefined();
  } finally {
    clearInterval(handle);
    await app.stop(true);
    await observed;
    if (previousData === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previousData;
    }
    await rm(data, { recursive: true, force: true });
  }
}, 40_000);

test("one startup budget bounds async plugin activation and never listens after late resolution", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-plugin-timeout-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const plugin = new Elysia().get("/late", () => "late");
  const pending = Promise.withResolvers<typeof plugin>();
  const app = createDesktopApp().use(pending.promise);
  let shutdowns = 0;
  let backend: Awaited<ReturnType<typeof startDesktopBackend>> | undefined;
  const startup = startDesktopBackend(
    () =>
      Promise.resolve({
        default: app,
        onShutdown: () => {
          shutdowns += 1;
        },
      }),
    data,
    "build"
  );
  const observed = startup.then(
    (value) => {
      backend = value;
      return "unexpected readiness";
    },
    (error: Error) => error.message
  );
  try {
    const outcome = await Promise.race([
      observed,
      Bun.sleep(31_000).then(() => "startup never settled"),
    ]);
    expect(outcome).toContain("30 seconds");
    expect(shutdowns).toBe(1);
    expect(app.server).toBeUndefined();
    pending.resolve(plugin);
    await app.modules;
    await Bun.sleep(20);
    expect(app.server).toBeUndefined();
    expect(shutdowns).toBe(1);
  } finally {
    pending.resolve(plugin);
    await observed;
    await backend?.stop();
    await app.stop(true);
    if (previousData === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previousData;
    }
    await rm(data, { recursive: true, force: true });
  }
}, 40_000);
