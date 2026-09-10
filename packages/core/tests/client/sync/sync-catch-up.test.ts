import { describe, expect, test } from "bun:test";
import {
  createInvalidationRefresh,
  createSyncCatchUp,
} from "../../../src/client/router/sync-catch-up.ts";

describe("createSyncCatchUp", () => {
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
