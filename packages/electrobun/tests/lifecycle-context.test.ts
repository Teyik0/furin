import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { startDesktopBackend } from "../src/runtime";
import { desktopApp } from "../src/server";

const ORIGIN = /^http:\/\/127\.0\.0\.1:/;
test("startup and ready receive the same runtime before authenticated requests", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-context-"));
  const previous = process.env.FURIN_APP_DATA_DIR;
  const phases: string[] = [];
  const app = new Elysia()
    .use(
      desktopApp({
        onStartup({ signal, runtime }) {
          expect(signal.aborted).toBe(false);
          expect(runtime.kind).toBe("server");
          phases.push("start");
        },
        onReady({ runtime, backend: readyBackend }) {
          expect(runtime.kind).toBe("server");
          expect(readyBackend.origin).toMatch(ORIGIN);
          phases.push("ready");
        },
        onShutdown() {
          phases.push("stop");
        },
      })
    )
    .get("/", () => phases.join(","));
  let backend: Awaited<ReturnType<typeof startDesktopBackend>> | undefined;
  try {
    backend = await startDesktopBackend(() => Promise.resolve({ default: app }), data, "build");
    expect(
      await (await fetch(backend.origin, { headers: { cookie: backend.cookie } })).text()
    ).toBe("start,ready");
    await backend.stop();
    expect(phases).toEqual(["start", "ready", "stop"]);
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
