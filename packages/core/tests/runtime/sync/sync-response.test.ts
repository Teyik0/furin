import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import type {
  BeginMutationResult,
  StoredResponse,
  SyncAdapter,
  SyncNotifier,
} from "../../../src/server/sync/adapter.ts";
import { furinSync } from "../../../src/server/sync/index.ts";

const notifier: SyncNotifier = {
  publish: async () => undefined,
  subscribe: async () => ({ unsubscribe: async () => undefined }),
};

interface SyncTestApp {
  handle: (request: Request) => Promise<Response> | Response;
}

function replayApp(storedHeaders: HeadersInit, replayHeaders: Record<string, string[]>) {
  let stored: StoredResponse | undefined;
  const adapter: SyncAdapter = {
    abortMutation: async () => undefined,
    beginMutation: async (): Promise<BeginMutationResult> =>
      stored === undefined
        ? {
            kind: "execute",
            lease: { id: "lease", key: "key", leaseMs: 60_000, principal: "test" },
          }
        : { kind: "replay", response: stored },
    completeMutation: (input) => {
      stored = input.response;
      return Promise.resolve({ cursor: undefined, kind: "committed" });
    },
    currentCursor: async () => "0",
    readChanges: async () => ({ changes: [], cursor: "0", hasMore: false, reset: false }),
    renewMutation: async () => "renewed",
    scope: "process-local",
  };

  return new Elysia()
    .use(furinSync({ adapter, notifier, principal: () => "test" }))
    .post("/mutation", { sync: { tags: [] } }, ({ set }) => {
      Object.assign(set.headers, replayHeaders);
      return new Response("stored", {
        headers: new Headers([["content-length", "6"], ...new Headers(storedHeaders).entries()]),
      });
    });
}

async function executeAndReplay(app: SyncTestApp): Promise<Response> {
  const request = () =>
    new Request("http://localhost/mutation", {
      headers: { "idempotency-key": "same-mutation" },
      method: "POST",
    });
  expect((await app.handle(request())).status).toBe(200);
  return app.handle(request());
}

test("furinSync replay preserves every configured header value", async () => {
  const response = await executeAndReplay(
    replayApp(
      { "x-furin-tag": "stale" },
      {
        "x-furin-tag": ["alpha", "beta"],
      }
    )
  );

  expect(response.headers.get("x-furin-tag")).toBe("alpha, beta");
});

test("furinSync replay discards configured cookies", async () => {
  const response = await executeAndReplay(
    replayApp(
      { "set-cookie": "old=1" },
      {
        "set-cookie": ["session=alpha; Path=/", "theme=dark; Path=/"],
      }
    )
  );

  expect(response.headers.getSetCookie()).toEqual([]);
});
