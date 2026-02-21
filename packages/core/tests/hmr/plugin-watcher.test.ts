/**
 * Integration tests for the HMR plugin's file-watcher behaviour.
 *
 * Each describe block spins up a real Elysia server, connects a real
 * WebSocket client, writes files to a temp directory, and asserts on
 * the messages the client receives.  This gives confidence that:
 *
 *   1. Deduplication: rapid writes produce exactly one broadcast.
 *   2. Extension filter: .txt is ignored; .ts/.tsx/.js/.jsx are handled.
 *   3. Broadcast path: the emitted module path uses the actual pagesDir
 *      basename, not the hardcoded string "pages".
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { createHmrPlugin } from "../../src/hmr/plugin";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP = join(tmpdir(), `elysion-plugin-watcher-${process.pid}`);

interface TestServer {
  stop: () => void;
  url: string;
}

async function startHmrServer(pagesDir: string): Promise<TestServer> {
  const plugin = createHmrPlugin(pagesDir);
  const app = new Elysia().use(plugin);
  app.listen(0);
  // Give the OS a moment to bind the port and start the watcher.
  // @parcel/watcher.subscribe() is async — wait long enough for it to be ready.
  await Bun.sleep(200);
  const port = app.server?.port;
  if (!port) {
    throw new Error("Server failed to bind a port");
  }
  return {
    url: `http://localhost:${port}`,
    stop: () => app.stop(),
  };
}

/**
 * Opens a WebSocket to /__elysion/hmr, waits for the "connected" ack,
 * calls `action`, waits for debounced events to settle, then closes the
 * socket and returns every non-"connected" message received.
 */
async function collectHmrMessages(
  serverUrl: string,
  action: () => void | Promise<void>,
  { waitMs = 500, settleMs = 150 }: { waitMs?: number; settleMs?: number } = {}
): Promise<Record<string, unknown>[]> {
  const wsUrl = `${serverUrl.replace("http://", "ws://")}/__elysion/hmr`;
  const messages: Record<string, unknown>[] = [];

  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`WebSocket failed to connect to ${wsUrl}`));
  });

  // Track when the last message was received so we can wait for settling.
  let lastMessageAt = 0;
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data as string) as Record<string, unknown>;
    if (data.type !== "connected") {
      messages.push(data);
      lastMessageAt = Date.now();
    }
  };

  await action();

  // Wait at least waitMs then keep polling until no new messages have arrived
  // for settleMs — avoids closing the socket while messages are still in-flight.
  await Bun.sleep(waitMs);
  while (Date.now() - lastMessageAt < settleMs) {
    await Bun.sleep(20);
  }

  ws.close();
  return messages;
}

// ---------------------------------------------------------------------------
// Suite 1 — deduplication + extension filter
// Both suites share a single server instance with pagesDir named "pages".
// ---------------------------------------------------------------------------

describe("HMR plugin — deduplication and extension filter", () => {
  const PAGES_DIR = join(TMP, "suite1", "pages");
  let server: TestServer;

  beforeAll(async () => {
    mkdirSync(PAGES_DIR, { recursive: true });
    server = await startHmrServer(PAGES_DIR);
  });

  afterAll(() => {
    server.stop();
    rmSync(join(TMP, "suite1"), { recursive: true, force: true });
  });

  // ── Deduplication ─────────────────────────────────────────────────────────

  test("rapid writes to the same file produce exactly one broadcast", async () => {
    const filePath = join(PAGES_DIR, "debounce.tsx");

    const messages = await collectHmrMessages(server.url, () => {
      // Write the same file 10 times synchronously.
      // @parcel/watcher deduplicates events natively.
      for (let i = 0; i < 10; i++) {
        writeFileSync(filePath, `export const v = ${i};`);
      }
    });

    expect(messages.length).toBe(1);
    expect(messages[0]?.type).toBe("update");
  });

  test("writes to two distinct files produce two independent broadcasts", async () => {
    const fileA = join(PAGES_DIR, "file-a.tsx");
    const fileB = join(PAGES_DIR, "file-b.tsx");

    const messages = await collectHmrMessages(
      server.url,
      async () => {
        writeFileSync(fileA, "export const a = 1;");
        // Separate the writes so @parcel/watcher (inotify on Linux) delivers
        // them as two distinct events instead of coalescing into one batch.
        await Bun.sleep(150);
        writeFileSync(fileB, "export const b = 2;");
      },
      // Longer collection window for slower CI VMs
      { waitMs: 800, settleMs: 300 }
    );

    expect(messages.length).toBeGreaterThanOrEqual(2);
    const paths = messages.map((m) => m.path as string);
    expect(paths.some((p) => p.endsWith("file-a.tsx"))).toBe(true);
    expect(paths.some((p) => p.endsWith("file-b.tsx"))).toBe(true);
  });

  // ── Extension filter ──────────────────────────────────────────────────────

  test(".txt files are ignored and produce no broadcast", async () => {
    const filePath = join(PAGES_DIR, "readme.txt");

    const messages = await collectHmrMessages(server.url, () => {
      writeFileSync(filePath, "plain text — should be ignored");
    });

    expect(messages.length).toBe(0);
  });

  test(".ts files trigger an HMR update", async () => {
    const filePath = join(PAGES_DIR, "utils.ts");

    const messages = await collectHmrMessages(server.url, () => {
      writeFileSync(filePath, "export const util = () => {};");
    });

    expect(messages.length).toBe(1);
    expect(messages[0]?.type).toBe("update");
  });

  test(".js files trigger an HMR update (V1 fix)", async () => {
    const filePath = join(PAGES_DIR, "helper.js");

    const messages = await collectHmrMessages(server.url, () => {
      writeFileSync(filePath, "export const helper = () => {};");
    });

    expect(messages.length).toBe(1);
    expect(messages[0]?.type).toBe("update");
  });

  test(".jsx files trigger an HMR update (V1 fix)", async () => {
    const filePath = join(PAGES_DIR, "widget.jsx");

    const messages = await collectHmrMessages(server.url, () => {
      writeFileSync(filePath, "export const Widget = () => null;");
    });

    expect(messages.length).toBe(1);
    expect(messages[0]?.type).toBe("update");
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — broadcast path uses basename(pagesDir), not a hardcoded string
// Uses a pagesDir named "routes" to catch the V3 regression.
// ---------------------------------------------------------------------------

describe("HMR plugin — broadcast path reflects pagesDir basename (V3 fix)", () => {
  // NOTE: naming this directory "routes" (not "pages") is what exercises the
  // fix.  Before the fix the path was always hardcoded to "/src/pages/…".
  const PAGES_DIR = join(TMP, "suite2", "routes");
  let server: TestServer;

  beforeAll(async () => {
    // Pre-create nested dirs so the watcher covers them from the start
    mkdirSync(join(PAGES_DIR, "blog"), { recursive: true });
    server = await startHmrServer(PAGES_DIR);
  });

  afterAll(() => {
    server.stop();
    rmSync(join(TMP, "suite2"), { recursive: true, force: true });
  });

  test("emitted path contains the correct pagesDir basename ('routes')", async () => {
    const filePath = join(PAGES_DIR, "index.tsx");

    const messages = await collectHmrMessages(server.url, () => {
      writeFileSync(filePath, "export const Page = () => null;");
    });

    expect(messages.length).toBe(1);
    const msg = messages[0] as {
      type: string;
      path: string;
      modules: string[];
    };
    expect(msg.type).toBe("update");
    // Path must use "routes", NOT the previously-hardcoded "pages".
    expect(msg.path).toContain("/src/routes/");
    expect(msg.path).not.toContain("/src/pages/");
    // modules array must match path
    expect(msg.modules).toEqual([msg.path]);
  });

  test("emitted path preserves nested filenames inside pagesDir", async () => {
    const subDir = join(PAGES_DIR, "blog");
    const filePath = join(subDir, "post.tsx");

    const messages = await collectHmrMessages(server.url, () => {
      writeFileSync(filePath, "export const Post = () => null;");
    });

    expect(messages.length).toBe(1);
    const msg = messages[0] as { path: string };
    expect(msg.path).toContain("routes/blog/post.tsx");
  });
});
