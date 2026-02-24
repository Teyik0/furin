import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { createVitePlugin } from "../../src/vite";

const TMP = join(tmpdir(), `elysion-vite-middleware-test-${process.pid}`);

describe("Vite Middleware", () => {
  const PROJECT_DIR = join(TMP, "project");
  let server: { stop: () => void; url: string; wsUrl: string };

  beforeAll(async () => {
    mkdirSync(PROJECT_DIR, { recursive: true });

    writeFileSync(
      join(PROJECT_DIR, "index.html"),
      `<!DOCTYPE html><html><body><script type="module" src="/src/main.tsx"></script></body></html>`
    );

    mkdirSync(join(PROJECT_DIR, "src"), { recursive: true });
    writeFileSync(join(PROJECT_DIR, "src", "main.tsx"), `export const main = "hello";`);

    const app = new Elysia().use(await createVitePlugin()).listen(0);

    server = {
      url: `http://localhost:${app.server?.port}`,
      stop: () => app.stop(),
      wsUrl: `ws://localhost:${app.server?.port}`,
    };
  });

  afterAll(() => {
    server.stop();
    rmSync(TMP, { recursive: true, force: true });
  });

  test("mounts Vite middleware and serves /@vite/client", async () => {
    const res = await fetch(`${server.url}/@vite/client`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");

    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("WebSocket");
  });

  test("serves transformed TypeScript file", async () => {
    const res = await fetch(`${server.url}/src/main.tsx`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");

    const body = await res.text();
    expect(body).toContain("main");
  });

  test("serves index.html with Vite scripts injected", async () => {
    const res = await fetch(`${server.url}/`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const body = await res.text();
    expect(body).toContain("/@vite/client");
  });

  test("HMR WebSocket endpoint accepts connection (requires Elysia WebSocket integration)", async () => {
    const ws = new WebSocket(server.wsUrl);

    const connected = await new Promise<boolean>((resolve) => {
      ws.onopen = () => {
        resolve(true);
      };
      ws.onerror = () => {
        resolve(false);
      };
    });

    expect(connected).toBe(true);

    ws.close();
  });
});
