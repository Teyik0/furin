import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { startDesktopBackend } from "../src/runtime";
import { desktopApp, getApplicationRuntime } from "../src/server";

const ORIGIN = /^http:\/\/127\.0\.0\.1:/;
test("Elysia owns async initialization and cleanup with access to the application runtime", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-context-"));
  const previous = process.env.FURIN_APP_DATA_DIR;
  const phases: string[] = [];
  const app = new Elysia()
    .use(desktopApp())
    .onStart(async (instance) => {
      expect(getApplicationRuntime(instance).kind).toBe("server");
      expect(instance.server?.url.origin).toMatch(ORIGIN);
      await Bun.sleep(10);
      phases.push("start");
    })
    .onStop(async () => {
      await Bun.sleep(10);
      phases.push("stop");
    })
    .get("/", () => phases.join(","));
  let backend: Awaited<ReturnType<typeof startDesktopBackend>> | undefined;
  try {
    backend = await startDesktopBackend(() => Promise.resolve({ default: app }), data, "build");
    expect(
      await (await fetch(backend.origin, { headers: { cookie: backend.cookie } })).text()
    ).toBe("start");
    await backend.stop();
    expect(phases).toEqual(["start", "stop"]);
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
