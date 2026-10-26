import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { startDesktopBackend } from "../src/runtime";
import { desktopApp } from "../src/server";

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((address) => address?.family === "IPv4" && !address.internal)?.address;
const hostnames = [
  { hostname: "127.0.0.1", destination: "127.0.0.1" },
  { hostname: "localhost", destination: "localhost" },
  { hostname: "::1", destination: "[::1]" },
  { hostname: "0.0.0.0", destination: "127.0.0.1" },
  { hostname: "::", destination: "[::1]" },
  ...(lanAddress ? [{ hostname: lanAddress, destination: lanAddress }] : []),
];

test.each(
  ["source", "host"].flatMap((mode) => [
    { mode, hostname: undefined, destination: mode === "source" ? "localhost" : "127.0.0.1" },
    ...hostnames.map((host) => ({ mode, ...host })),
  ])
)("$mode listener navigates through $destination", async ({ mode, hostname, destination }) => {
  const data = await mkdtemp(join(tmpdir(), "furin-listener-origin-"));
  const previous = process.env.FURIN_APP_DATA_DIR;
  let backend: Awaited<ReturnType<typeof startDesktopBackend>> | undefined;
  let listenerUrl: URL | undefined;
  try {
    backend = await startDesktopBackend(
      () => {
        const app = new Elysia({
          serve: {
            hostname: mode === "source" && hostname !== undefined ? "127.0.0.1" : hostname,
            port: 0,
          },
        })
          .use(desktopApp())
          .onStart((instance) => {
            listenerUrl = instance.server?.url;
          })
          .get("/", () => "app");
        return Promise.resolve({
          default:
            mode === "source"
              ? app.listen(hostname === undefined ? 0 : { hostname, port: 0 })
              : app,
        });
      },
      data,
      "build"
    );
    expect(new URL(backend.origin).hostname).toBe(destination);
    expect(listenerUrl?.port).toBe(new URL(backend.origin).port);
    expect(new URL(backend.bootstrapOrigin).hostname).toBe(destination);
    expect((await fetch(backend.origin)).status).toBe(403);
    const bootstrap = await fetch(backend.url, { redirect: "manual" });
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.get("location")).toBe(`${backend.origin}/`);
    expect(bootstrap.headers.get("set-cookie")).toStartWith(`${backend.cookie};`);
    expect(
      await (
        await fetch(backend.origin, {
          headers: {
            cookie: backend.cookie,
            referer: `${backend.bootstrapOrigin}/`,
            "sec-fetch-site": "same-site",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
          },
        })
      ).text()
    ).toBe("app");
    expect(
      (
        await fetch(backend.origin, {
          headers: { cookie: backend.cookie, origin: "https://other.example" },
        })
      ).status
    ).toBe(403);
    expect((await fetch(backend.url, { redirect: "manual" })).status).toBe(410);
  } finally {
    await backend?.stop();
    if (previous === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previous;
    }
    await rm(data, { recursive: true, force: true });
  }
});

test.each(["source", "host"])("%s Unix listener is rejected and closed", async (mode) => {
  const data = await mkdtemp(join(tmpdir(), "furin-listener-unix-"));
  const previous = process.env.FURIN_APP_DATA_DIR;
  const unix = join(data, "app.sock");
  let stopped = false;
  try {
    await expect(
      startDesktopBackend(
        () => {
          const app = new Elysia({ serve: mode === "host" ? { unix } : undefined })
            .use(desktopApp())
            .onStop(() => {
              stopped = true;
            })
            .get("/", () => "app");
          return Promise.resolve({ default: mode === "source" ? app.listen({ unix }) : app });
        },
        data,
        "build"
      )
    ).rejects.toThrow("TCP listener");
    if (mode === "source") {
      expect(stopped).toBe(true);
      await expect(fetch("http://localhost/", { unix })).rejects.toThrow();
    }
  } finally {
    if (previous === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previous;
    }
    await rm(data, { recursive: true, force: true });
  }
});
