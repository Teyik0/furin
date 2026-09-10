import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER_READY_TIMEOUT_MS = 10_000;
const HTTP_TIMEOUT_MS = 5000;
const EVENT_TIMEOUT_MS = 2000;
const SERVER_URL_PATTERN = /Task Manager running at (http:\/\/localhost:\d+)/;

interface CreatedBoard {
  createdAt: string;
  id: string;
  name: string;
}

interface SyncChangesResponse {
  changes: Array<{
    cursor: string;
    invalidations: string[];
  }>;
  cursor: string;
  hasMore: boolean;
  reset: boolean;
}

interface SyncEnvelope {
  channel: "sync";
  data: { cursor: string };
  version: 1;
}

function openSyncSocket(baseUrl: string): {
  close: () => void;
  next: () => Promise<SyncEnvelope>;
} {
  const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/_furin/events`);
  const queued: SyncEnvelope[] = [];
  const waiting = new Set<{
    reject: (error: Error) => void;
    resolve: (event: SyncEnvelope) => void;
  }>();
  const rejectWaiting = (message: string): void => {
    for (const waiter of waiting) {
      waiter.reject(new Error(message));
    }
    waiting.clear();
  };
  socket.addEventListener("close", () => rejectWaiting("Browser events closed"));
  socket.addEventListener("error", () => rejectWaiting("Browser events failed"));
  socket.addEventListener("message", (message) => {
    const event = JSON.parse(String(message.data)) as SyncEnvelope;
    if (event.channel !== "sync") {
      return;
    }
    const waiter = waiting.values().next().value;
    if (waiter) {
      waiting.delete(waiter);
      waiter.resolve(event);
    } else {
      queued.push(event);
    }
  });
  return {
    close: () => socket.close(),
    next: () => {
      const event = queued.shift();
      if (event) {
        return Promise.resolve(event);
      }
      if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        return Promise.reject(new Error("Browser events closed"));
      }
      let waiter:
        | {
            reject: (error: Error) => void;
            resolve: (event: SyncEnvelope) => void;
          }
        | undefined;
      const eventPromise = new Promise<SyncEnvelope>((resolve, reject) => {
        waiter = { reject, resolve };
        waiting.add(waiter);
      });
      return withTimeout(eventPromise, "the sync browser event", EVENT_TIMEOUT_MS).finally(() => {
        if (waiter) {
          waiting.delete(waiter);
        }
      });
    },
  };
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

async function readOutput(
  stream: ReadableStream<Uint8Array>,
  onOutput: (output: string) => void
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let output = "";
  let chunk = await reader.read();

  while (!chunk.done) {
    output += decoder.decode(chunk.value, { stream: true });
    onOutput(output);
    // biome-ignore lint/performance/noAwaitInLoops: process output must be consumed sequentially.
    chunk = await reader.read();
  }

  output += decoder.decode();
  onOutput(output);
  return output;
}

describe.serial("task-manager production E2E", () => {
  const serverPath = join(import.meta.dir, "../.furin/build/bun/server");
  const workingDirectory = mkdtempSync(join(tmpdir(), "furin-task-manager-e2e-"));
  const ready = Promise.withResolvers<string>();
  let baseUrl = "";
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let stderrOutput: Promise<string> | undefined;
  let stdoutOutput: Promise<string> | undefined;

  beforeAll(async () => {
    if (!existsSync(serverPath)) {
      throw new Error("Task-manager production binary is missing. Run `bun run build` first.");
    }

    server = Bun.spawn({
      cmd: [serverPath],
      cwd: workingDirectory,
      env: { ...process.env, PORT: "0" },
      stderr: "pipe",
      stdout: "pipe",
    });
    stdoutOutput = readOutput(server.stdout, (output) => {
      const match = output.match(SERVER_URL_PATTERN);
      if (match?.[1]) {
        ready.resolve(match[1]);
      }
    });
    stderrOutput = new Response(server.stderr).text();

    baseUrl = await withTimeout(
      Promise.race([
        ready.promise,
        server.exited.then(async (exitCode) => {
          const stderr = await stderrOutput;
          throw new Error(`Task-manager exited with code ${exitCode}.\n${stderr}`);
        }),
      ]),
      "the task-manager server",
      SERVER_READY_TIMEOUT_MS
    );
  }, 15_000);

  afterAll(async () => {
    server?.kill();
    await server?.exited;
    await Promise.allSettled([stdoutOutput, stderrOutput]);
    rmSync(workingDirectory, { force: true, recursive: true });
  }, 15_000);

  test("a synced board mutation reaches two browser tabs, the durable journal, and the invalidated ISR page", async () => {
    const boardName = `E2E board ${crypto.randomUUID()}`;
    const idempotencyKey = crypto.randomUUID();

    const initialPage = await withTimeout(
      fetch(`${baseUrl}/`),
      "the initial page",
      HTTP_TIMEOUT_MS
    );
    expect(initialPage.status).toBe(200);
    expect(await initialPage.text()).toContain("Task Manager");

    const firstTab = openSyncSocket(baseUrl);
    const secondTab = openSyncSocket(baseUrl);

    try {
      const initialCursors = await Promise.all([firstTab.next(), secondTab.next()]);
      expect(initialCursors.map((event) => event.data.cursor)).toEqual(["0", "0"]);
      const notifications = [firstTab.next(), secondTab.next()];

      const createBoard = () =>
        fetch(`${baseUrl}/api/boards`, {
          body: JSON.stringify({ name: boardName }),
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          method: "POST",
        });

      const createResponse = await withTimeout(
        createBoard(),
        "the board mutation",
        HTTP_TIMEOUT_MS
      );
      expect(createResponse.status).toBe(200);
      expect(createResponse.headers.get("x-furin-revalidate")).toBe("/,/rsc,/board:layout");
      expect(createResponse.headers.get("x-furin-sync")).toBe("1");
      const createdBoard = (await createResponse.json()) as CreatedBoard;
      expect(createdBoard).toMatchObject({ name: boardName });

      expect((await Promise.all(notifications)).map((event) => event.data.cursor)).toEqual([
        "1",
        "1",
      ]);

      const changesResponse = await withTimeout(
        fetch(`${baseUrl}/_furin/sync/changes?after=0`),
        "the durable sync changes",
        HTTP_TIMEOUT_MS
      );
      expect(changesResponse.status).toBe(200);
      const changes = (await changesResponse.json()) as SyncChangesResponse;
      expect(changes).toMatchObject({ cursor: "1", hasMore: false, reset: false });
      expect(changes.changes).toEqual([
        {
          cursor: "1",
          invalidations: ["/:layout", "/", "/rsc", "/board:layout"],
        },
      ]);

      const replayResponse = await withTimeout(
        createBoard(),
        "the idempotent mutation replay",
        HTTP_TIMEOUT_MS
      );
      expect(replayResponse.status).toBe(200);
      expect(await replayResponse.json()).toEqual(createdBoard);

      const boardsResponse = await withTimeout(
        fetch(`${baseUrl}/api/boards`),
        "the boards API",
        HTTP_TIMEOUT_MS
      );
      const boards = (await boardsResponse.json()) as CreatedBoard[];
      expect(boards.filter((board) => board.name === boardName)).toHaveLength(1);

      const invalidatedPage = await withTimeout(
        fetch(`${baseUrl}/`),
        "the invalidated ISR page",
        HTTP_TIMEOUT_MS
      );
      expect(invalidatedPage.status).toBe(200);
      expect(await invalidatedPage.text()).toContain(boardName);
    } finally {
      firstTab.close();
      secondTab.close();
    }
  });
});
