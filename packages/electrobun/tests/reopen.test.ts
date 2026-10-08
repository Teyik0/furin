import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDesktopBackend } from "../src/host";
import { createDesktopApp } from "../src/server";

test("a host can reopen an authenticated window without reusing a spent bootstrap", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-reopen-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const app = createDesktopApp().get("/", () => "ready");
  let owned: Awaited<ReturnType<typeof startDesktopBackend>> | undefined;
  try {
    const backend = await startDesktopBackend(
      () => Promise.resolve({ default: app }),
      data,
      "build"
    );
    owned = backend;
    const first = await fetch(backend.url, { redirect: "manual" });
    expect(first.status).toBe(303);
    expect((await fetch(backend.url, { redirect: "manual" })).status).toBe(410);
    const reopened = backend.createWindowUrl();
    expect(reopened).not.toBe(backend.url);
    const response = await fetch(reopened, { redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toBe(first.headers.get("set-cookie"));
    expect((await fetch(backend.origin)).status).toBe(403);
    expect((await fetch(backend.origin, { headers: { cookie: backend.cookie } })).status).toBe(200);
    expect((await fetch(reopened, { redirect: "manual" })).status).toBe(410);
    const download = await fetch(backend.createWindowUrl("/download?version=1"), {
      redirect: "manual",
    });
    expect(download.headers.get("location")).toBe(`${backend.origin}/download?version=1`);
    expect(() => backend.createWindowUrl("https://example.com/")).toThrow("origin");
    await backend.stop();
    expect(() => backend.createWindowUrl()).toThrow("stopped");
  } finally {
    try {
      await owned?.stop();
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
