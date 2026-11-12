import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDesktopBackend } from "../src/host";
import { createDesktopApp } from "../src/server";

test("desktop initializes application resources before serving authenticated requests", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-startup-hook-"));
  let ready = false;
  const app = createDesktopApp().get("/", () => (ready ? "ready" : "starting"));
  let shutdowns = 0;
  let backend: Awaited<ReturnType<typeof startDesktopBackend>> | undefined;
  try {
    backend = await startDesktopBackend(
      () =>
        Promise.resolve({
          default: app
            .onStart(async () => {
              expect(app.server?.port).toBeGreaterThan(0);
              await Bun.sleep(10);
              ready = true;
            })
            .onStop(() => {
              shutdowns += 1;
            }),
        }),
      data,
      "build"
    );
    const response = await fetch(backend.origin, { headers: { cookie: backend.cookie } });
    expect(await response.text()).toBe("ready");
    await backend.stop();
    expect(shutdowns).toBe(1);
  } finally {
    try {
      await backend?.stop();
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  }
});
