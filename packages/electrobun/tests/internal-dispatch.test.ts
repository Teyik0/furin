import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { Elysia, t } from "elysia";
import type { DesktopSdk } from "../src/native-sdk";
import { startDesktopBackend } from "../src/runtime";
import { desktopApp } from "../src/server";
import { runStandardDesktopHost } from "../src/standard-host";
import { installSdk } from "./fixtures/sdk";

test("Bun HTTP dispatch supplies its server while Eden handle dispatch has no adapter argument", async () => {
  const argumentsSeen: unknown[][] = [];
  const app = new Elysia()
    .use(desktopApp())
    .wrap((next) => (request, ...rest: unknown[]) => {
      argumentsSeen.push(rest);
      return next(request, ...rest);
    })
    .get("/api/value", () => ({ value: 42 }));
  try {
    await new Promise<void>((resolve) =>
      app.listen({ hostname: "127.0.0.1", port: 0 }, () => resolve())
    );
    expect((await fetch(`http://127.0.0.1:${app.server?.port}/api/value`)).status).toBe(200);
    expect(argumentsSeen[0]).toEqual([app.server]);
    expect((await treaty(app).api.value.get()).data).toEqual({ value: 42 });
    expect(argumentsSeen[1]).toEqual([]);
  } finally {
    await app.stop(true);
  }
});

test("desktop Eden and the furinSync Eden plugin read/mutate the listening application without HTTP credentials", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-eden-"));
  const previous = process.env.FURIN_APP_DATA_DIR;
  const values: string[] = [];
  const received: unknown[][] = [];
  const app = new Elysia()
    .use(desktopApp({ restrictWebToLoopback: true }))
    .wrap((next) => (request, ...rest: unknown[]) => {
      received.push(rest);
      return next(request, ...rest);
    })
    .get("/api/values", () => values)
    .post("/api/values", { body: t.Object({ value: t.String() }) }, ({ body }) => {
      values.push(body.value);
      return values;
    });
  const { furinSync } = await import(Bun.resolveSync("@teyik0/furin/client", import.meta.dir));
  const client = treaty(app).use(furinSync).api;
  const eden = treaty(app).api;
  app.get("/ssr", async () => {
    const result = await client.values.get();
    return result.error
      ? new Response("Internal API failed", { status: 500 })
      : new Response(`<main>${result.data?.join(",")}</main>`, {
          headers: { "content-type": "text/html" },
        });
  });
  let backend: Awaited<ReturnType<typeof startDesktopBackend>> | undefined;
  try {
    backend = await startDesktopBackend(() => Promise.resolve({ default: app }), data, "build");
    expect((await fetch(`${backend.origin}/api/values`)).status).toBe(403);
    const read = await eden.values.get();
    expect(read.status).toBe(200);
    expect(read.data).toEqual([]);
    expect(received.at(-1)).toEqual([]);
    const write = await eden.values.post({ value: "internal" });
    expect(write.status).toBe(200);
    expect(write.data).toEqual(["internal"]);
    expect((await client.values.get()).data).toEqual(["internal"]);
    expect((await client.values.post({ value: "client" })).data).toEqual(["internal", "client"]);
    const headers = { cookie: backend.cookie, origin: backend.origin };
    expect(await (await fetch(`${backend.origin}/ssr`, { headers })).text()).toBe(
      "<main>internal,client</main>"
    );
    expect(received.some((rest) => rest[0] === app.server)).toBe(true);
    const before = received.length;
    const forged: RequestInit["headers"][] = [
      { host: "e.ly", cookie: backend.cookie },
      { origin: "http://e.ly", cookie: backend.cookie },
      { cookie: backend.cookie, "sec-fetch-site": "cross-site" },
      { cookie: backend.cookie, "sec-fetch-site": "same-site" },
      { cookie: backend.cookie, referer: "http://127.0.0.1:1/page" },
      { "x-furin-internal": "true", "x-forwarded-host": "e.ly" },
      { cookie: "forged=invalid", origin: backend.origin },
    ];
    const rejected = await Promise.all(
      forged.map((forgedHeaders) =>
        fetch(`${backend?.origin}/api/values`, { headers: forgedHeaders })
      )
    );
    for (const response of rejected) {
      expect(response.status).toBe(403);
    }
    expect(received).toHaveLength(before);
    expect(
      (
        await eden.values.get({
          headers: { origin: "https://foreign.test", "sec-fetch-site": "cross-site" },
        })
      ).status
    ).toBe(200);
  } finally {
    try {
      await backend?.stop();
    } finally {
      if (previous === undefined) {
        delete process.env.FURIN_APP_DATA_DIR;
      } else {
        process.env.FURIN_APP_DATA_DIR = previous;
      }
      await rm(data, { recursive: true, force: true });
    }
  }
});

test("both desktop transports are blocked during startup, update pause and shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-eden-lifecycle-"));
  const previous = process.env.FURIN_APP_DATA_DIR;
  const started = Promise.withResolvers<void>();
  const releaseStartup = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<{ origin: string; cookie?: string }>();
  const releaseReady = Promise.withResolvers<void>();
  const applying = Promise.withResolvers<void>();
  const releaseUpdate = Promise.withResolvers<void>();
  let bodies = 0;
  let desktop: Awaited<ReturnType<typeof runStandardDesktopHost>>;
  let pending: Promise<Awaited<ReturnType<typeof runStandardDesktopHost>>> | undefined;
  const app = new Elysia()
    .use(
      desktopApp({
        async onStartup() {
          started.resolve();
          await releaseStartup.promise;
        },
        async onReady({ backend }) {
          ready.resolve(backend);
          await releaseReady.promise;
        },
      })
    )
    .get("/api/value", () => {
      bodies += 1;
      return "ready";
    });
  const eden = treaty(app).api;
  try {
    await mkdir(join(root, ".furin/electrobun"), { recursive: true });
    const identity = { name: "Fixture", identifier: "local.furin.eden", version: "1.0.0" };
    await writeFile(join(root, ".furin/electrobun/host.json"), JSON.stringify({ app: identity }));
    await installSdk(root);
    const sdk = (await import(join(root, "node_modules/electrobun/main.ts"))) as DesktopSdk;
    sdk.Utils.quit = () => true;
    sdk.Updater.updateInfo().updateReady = true;
    sdk.Updater.applyUpdate = async () => {
      applying.resolve();
      await releaseUpdate.promise;
    };
    sdk.Updater.getStatusHistory = () => [
      { status: "launching-new-version", message: "ready", timestamp: Date.now() },
    ];
    pending = runStandardDesktopHost(sdk, {
      config: { app: identity, window: { width: 800, height: 600 } },
      root,
      dataDir: join(root, "data"),
      mode: "build",
      load: async () => ({ default: app }),
    });
    await started.promise;
    expect((await eden.value.get()).status).toBe(503);
    expect(bodies).toBe(0);
    releaseStartup.resolve();
    const listening = await ready.promise;
    expect((await eden.value.get()).status).toBe(503);
    expect(
      (
        await fetch(`${listening.origin}/api/value`, {
          headers: { cookie: listening.cookie ?? "", origin: listening.origin },
        })
      ).status
    ).toBe(503);
    expect(bodies).toBe(0);
    releaseReady.resolve();
    desktop = await pending;
    if (!desktop) {
      throw new Error("Missing primary host.");
    }
    const bootstrap = await fetch(await Bun.file(join(root, "window-url")).text(), {
      redirect: "manual",
    });
    const location = bootstrap.headers.get("location");
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    if (!(location && cookie)) {
      throw new Error("Missing bootstrap session.");
    }
    const { origin } = new URL(location);
    expect((await eden.value.get()).status).toBe(200);
    expect((await fetch(`${origin}/api/value`, { headers: { cookie, origin } })).status).toBe(200);
    const installing = desktop.updates.install();
    await applying.promise;
    const count = bodies;
    expect((await eden.value.get()).status).toBe(503);
    expect((await fetch(`${origin}/api/value`, { headers: { cookie, origin } })).status).toBe(503);
    expect(bodies).toBe(count);
    releaseUpdate.resolve();
    await installing;
    await desktop.quit();
    expect((await eden.value.get()).status).toBe(503);
    expect(bodies).toBe(count);
    await expect(fetch(`${origin}/api/value`, { headers: { cookie, origin } })).rejects.toThrow();
  } finally {
    releaseStartup.resolve();
    releaseReady.resolve();
    releaseUpdate.resolve();
    try {
      await (await pending)?.quit();
    } finally {
      if (previous === undefined) {
        delete process.env.FURIN_APP_DATA_DIR;
      } else {
        process.env.FURIN_APP_DATA_DIR = previous;
      }
      await rm(root, { recursive: true, force: true });
    }
  }
}, 10_000);
