import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDesktopBackend } from "../src/runtime";
import { createDesktopApp } from "../src/server";

test("bootstrap credentials never pass through prior application hooks or wrappers", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-auth-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const hookPaths: string[] = [];
  const wrapPaths: string[] = [];
  const app = createDesktopApp()
    .request(({ request }) => {
      hookPaths.push(new URL(request.url).pathname);
    })
    .wrap((next) => (request) => {
      wrapPaths.push(new URL(request.url).pathname);
      return next(request);
    })
    .get("/", () => "app");
  const backend = await startDesktopBackend(() => Promise.resolve({ default: app }), data, "build");
  try {
    const bootstrap = await fetch(backend.url, { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Missing bootstrap cookie.");
    }
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.get("location")).toBe(`${backend.origin}/`);
    expect(new URL(backend.url).origin).not.toBe(backend.origin);
    expect(new URL(backend.url).pathname).not.toContain(cookie.slice(cookie.indexOf("=") + 1));
    expect(hookPaths).toEqual([]);
    expect(wrapPaths).toEqual([]);
    expect(await (await fetch(`${backend.origin}/`, { headers: { cookie } })).text()).toBe("app");
    expect(hookPaths).toEqual(["/"]);
    expect(wrapPaths).toEqual(["/"]);
    expect((await fetch(backend.url, { redirect: "manual" })).status).toBe(410);
    expect((await fetch(new URL("/", backend.url))).status).toBe(410);
    expect((await fetch(`${backend.origin}/`)).status).toBe(403);
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

test("instance cookies coexist on loopback without authenticating another backend or cross-site requests", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-auth-pair-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const first = await startDesktopBackend(
    () =>
      Promise.resolve({
        default: createDesktopApp().get("/", () => "first"),
      }),
    join(data, "first"),
    "build"
  );
  const second = await startDesktopBackend(
    () =>
      Promise.resolve({
        default: createDesktopApp().get("/", () => "second"),
      }),
    join(data, "second"),
    "build"
  );
  try {
    expect(
      (await fetch(first.url, { headers: { origin: "https://evil.example" }, redirect: "manual" }))
        .status
    ).toBe(403);
    const one = await fetch(first.url, { redirect: "manual" });
    const two = await fetch(second.url, { redirect: "manual" });
    const cookieOne = one.headers.get("set-cookie")?.split(";")[0];
    const cookieTwo = two.headers.get("set-cookie")?.split(";")[0];
    if (!(cookieOne && cookieTwo)) {
      throw new Error("Missing instance cookies.");
    }
    expect(one.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict; Path=/");
    expect(two.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict; Path=/");
    expect(cookieOne.split("=")[0]).not.toBe(cookieTwo.split("=")[0]);
    expect(cookieOne.split("=")[1]).not.toBe(cookieTwo.split("=")[1]);
    expect((await fetch(first.origin, { headers: { cookie: cookieTwo } })).status).toBe(403);
    expect((await fetch(second.origin, { headers: { cookie: cookieOne } })).status).toBe(403);
    const cookies = `${cookieOne}; ${cookieTwo}`;
    expect(await (await fetch(first.origin, { headers: { cookie: cookies } })).text()).toBe(
      "first"
    );
    expect(await (await fetch(second.origin, { headers: { cookie: cookies } })).text()).toBe(
      "second"
    );
    expect(
      (await fetch(first.origin, { headers: { cookie: cookies, origin: second.origin } })).status
    ).toBe(403);
    expect(
      (await fetch(first.origin, { headers: { cookie: cookies, "sec-fetch-site": "cross-site" } }))
        .status
    ).toBe(403);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
    if (previousData === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previousData;
    }
    await rm(data, { recursive: true, force: true });
  }
});

test("spent bootstrap remains bound while cleanup drains and both listeners close on shutdown", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-bootstrap-drain-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const entered = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const backend = await startDesktopBackend(
    () =>
      Promise.resolve({
        default: createDesktopApp().get("/", () => "app"),
        onShutdown: () => {
          entered.resolve();
          return cleanup.promise;
        },
      }),
    data,
    "build"
  );
  try {
    expect((await fetch(backend.url, { redirect: "manual" })).status).toBe(303);
    const stopped = backend.stop();
    await entered.promise;
    expect((await fetch(backend.url, { redirect: "manual" })).status).toBe(410);
    cleanup.resolve();
    await stopped;
    await expect(fetch(backend.url)).rejects.toThrow();
    await expect(fetch(backend.origin)).rejects.toThrow();
  } finally {
    cleanup.resolve();
    await backend.stop();
    if (previousData === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previousData;
    }
    await rm(data, { recursive: true, force: true });
  }
});
