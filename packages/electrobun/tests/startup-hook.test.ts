import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDesktopBackend } from "../src/host";
import { createDesktopApp } from "../src/server";

test("desktop initializes application resources before serving authenticated requests", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-startup-hook-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  let ready = false;
  const app = createDesktopApp().get("/", () => (ready ? "ready" : "starting"));
  let shutdowns = 0;
  const backend = await startDesktopBackend(
    () =>
      Promise.resolve({
        default: app,
        onStartup: async () => {
          expect(app.server).toBeUndefined();
          await Bun.sleep(10);
          ready = true;
        },
        onShutdown: () => {
          shutdowns += 1;
        },
      }),
    data,
    "build"
  );
  try {
    const response = await fetch(backend.origin, { headers: { cookie: backend.cookie } });
    expect(await response.text()).toBe("ready");
    await backend.stop();
    expect(shutdowns).toBe(1);
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
