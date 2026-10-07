import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  applyRevalidateEntries,
  shouldAutoRefreshPath,
} from "../../../src/client/router/link-utils.ts";
import {
  createInvalidationRefresh,
  createSyncCatchUp,
} from "../../../src/client/router/sync-catch-up.ts";
import { migrateSqliteSync, sqliteSyncAdapter } from "../../../src/server/sync/sqlite/index.ts";
import { createSyncChangesPlugin } from "../../../src/server/sync/stream.ts";
import { queryTag } from "../../../src/shared/sync-query.ts";

describe("createSyncCatchUp", () => {
  test("legacy journal paths preserve encoded slashes through the recovery transport", async () => {
    const app = new Elysia().get("/changes", () => ({
      changes: [{ cursor: "1", invalidations: ["/a%2Fb:layout", "/東京/%25"] }],
      cursor: "1",
      hasMore: false,
      reset: false,
    }));
    const paths: { path: string; type: "page" | "layout" }[] = [];
    const sync = createSyncCatchUp({
      fetchPage: async () => {
        const response = await app.handle(new Request("http://localhost/changes"));
        return response.json();
      },
      onInvalidations: (entries) =>
        applyRevalidateEntries(entries, (path, type) => paths.push({ path, type: type ?? "page" })),
    });
    await sync.catchUp();
    expect(paths).toEqual([
      { path: "/a%2Fb", type: "layout" },
      { path: "/東京/%25", type: "page" },
    ]);
    expect(shouldAutoRefreshPath("/a%2Fb/child", paths)).toBe(true);
    expect(shouldAutoRefreshPath("/a/b/child", paths)).toBe(false);
  });
  test("applies the typed path records returned by the real changes endpoint", async () => {
    const database = new Database(":memory:");
    migrateSqliteSync(database);
    const adapter = sqliteSyncAdapter({ database, namespace: "typed-path" });
    const lease = await adapter.beginMutation({
      key: "typed-path",
      fingerprint: "body",
      principal: "alice",
    });
    if (lease.kind !== "execute") {
      throw new Error("Expected mutation lease");
    }
    await adapter.completeMutation({
      lease: lease.lease,
      response: { status: 200, body: new Uint8Array(), headers: [] },
      invalidations: [
        { kind: "path", path: "/foo:layout", type: "page" },
        { kind: "path", path: "/東京", type: "layout" },
      ],
    });
    const app = new Elysia().use(createSyncChangesPlugin({ adapter, principal: () => "alice" }));
    const paths: { path: string; type: string | undefined }[] = [];
    try {
      const sync = createSyncCatchUp({
        fetchPage: async (after) => {
          const response = await app.handle(
            new Request(`http://localhost/_furin/sync/changes?after=${after}`)
          );
          return response.json();
        },
        onInvalidations: (entries) =>
          applyRevalidateEntries(entries, (path, type) => paths.push({ path, type })),
      });
      await sync.catchUp();
      expect(paths).toEqual([
        { path: "/foo:layout", type: "page" },
        { path: "/東京", type: "layout" },
      ]);
    } finally {
      database.close();
    }
  });
  test("recovers query identities from journal tags and refreshes unrecognized cache tags", async () => {
    const identity = { id: "cards", scope: { board: 42 } };
    const queries: object[] = [];
    const paths: string[] = [];
    const sync = createSyncCatchUp({
      fetchPage: () =>
        Promise.resolve({
          changes: [
            {
              cursor: "1",
              invalidations: [{ kind: "tags", tags: [queryTag(identity), "custom-cache-tag"] }],
            },
          ],
          cursor: "1",
          hasMore: false,
          reset: false,
        }),
      onInvalidations: (entries) => paths.push(...entries),
      onQueries: (identities) => queries.push(...identities),
    });
    await sync.catchUp();
    expect(queries).toEqual([identity]);
    expect(paths).toEqual(["/:layout"]);
  });

  test("starts at cursor zero and applies every paginated change", async () => {
    const requestedAfter: Array<string | undefined> = [];
    const invalidations: string[][] = [];
    const pages = [
      {
        changes: [{ cursor: "3", invalidations: ["/board"] }],
        cursor: "3",
        hasMore: true,
        reset: false,
      },
      {
        changes: [{ cursor: "4", invalidations: ["/sidebar:layout"] }],
        cursor: "4",
        hasMore: false,
        reset: false,
      },
    ];
    const sync = createSyncCatchUp({
      fetchPage: (after) => {
        requestedAfter.push(after);
        const page = pages.shift();
        if (!page) {
          throw new Error("Unexpected sync page request");
        }
        return Promise.resolve(page);
      },
      onInvalidations: (entries) => invalidations.push([...entries]),
    });

    await sync.catchUp();

    expect(requestedAfter).toEqual(["0", "3"]);
    expect(invalidations).toEqual([["/board"], ["/sidebar:layout"]]);
    expect(sync.cursor()).toBe("4");
  });

  test("fully invalidates when catch-up reports a reset", async () => {
    const requestedAfter: Array<string | undefined> = [];
    const invalidations: string[] = [];
    const sync = createSyncCatchUp({
      fetchPage: (after) => {
        requestedAfter.push(after);
        return Promise.resolve({
          changes: [{ cursor: "8", invalidations: ["/stale-increment"] }],
          cursor: "8",
          hasMore: false,
          reset: true,
        });
      },
      onInvalidations: (entries) => invalidations.push(...entries),
    });

    await sync.catchUp();

    expect(requestedAfter).toEqual(["0"]);
    expect(invalidations).toEqual(["/:layout"]);
    expect(sync.cursor()).toBe("8");
  });

  test("starts from a cursor supplied by the sync stream", async () => {
    const requestedAfter: Array<string | undefined> = [];
    const sync = createSyncCatchUp({
      fetchPage: (after) => {
        requestedAfter.push(after);
        return Promise.resolve({
          changes: [],
          cursor: "12",
          hasMore: false,
          reset: false,
        });
      },
      onInvalidations: () => undefined,
    });

    sync.seed("12");
    await sync.catchUp();

    expect(requestedAfter).toEqual(["12"]);
  });
});

describe("createInvalidationRefresh", () => {
  test("runs a coalesced follow-up refresh after a navigation abort", async () => {
    let calls = 0;
    let rejectRefresh: ((error: unknown) => void) | undefined;
    const errors: unknown[] = [];
    const refresh = createInvalidationRefresh({
      onError: (error) => errors.push(error),
      refresh: () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<void>((_resolve, reject) => {
            rejectRefresh = reject;
          });
        }
        return Promise.resolve();
      },
    });

    const first = refresh.run();
    const second = refresh.run();
    rejectRefresh?.(new DOMException("Navigation superseded", "AbortError"));

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(calls).toBe(2);
    expect(errors).toEqual([]);
  });

  test("runs a follow-up refresh when invalidated during a refresh", async () => {
    let calls = 0;
    let finishFirst: (() => void) | undefined;
    const refresh = createInvalidationRefresh({
      onError: () => undefined,
      refresh: () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<void>((resolve) => {
            finishFirst = resolve;
          });
        }
        return Promise.resolve();
      },
    });

    const first = refresh.run();
    const second = refresh.run();
    finishFirst?.();
    await Promise.all([first, second]);

    expect(calls).toBe(2);
  });
});
