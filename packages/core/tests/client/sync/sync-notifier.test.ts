import { describe, expect, test } from "bun:test";
import type { SyncAdapter } from "../../../src/server/sync/adapter.ts";
import { PollingSyncNotifier } from "../../../src/server/sync/notifier.ts";

function adapterWithCursor(currentCursor: () => Promise<string>): SyncAdapter {
  return {
    abortMutation: () => Promise.resolve(),
    beginMutation: () => Promise.resolve({ kind: "conflict", reason: "in-progress" }),
    completeMutation: () => Promise.resolve({ kind: "lost" }),
    currentCursor,
    readChanges: () => Promise.resolve({ changes: [], cursor: "0", hasMore: false, reset: false }),
    renewMutation: () => Promise.resolve("lost"),
    scope: "distributed",
  };
}

describe("PollingSyncNotifier", () => {
  test("removes a listener when initial cursor lookup fails", async () => {
    const notifier = new PollingSyncNotifier(
      adapterWithCursor(() => Promise.reject(new Error("adapter unavailable"))),
      10
    );
    let delivered = 0;

    await expect(
      notifier.subscribe(() => {
        delivered += 1;
      })
    ).rejects.toThrow("adapter unavailable");
    await notifier.publish("1");

    expect(delivered).toBe(0);
  });

  test("shares cursor initialization across concurrent subscriptions", async () => {
    const initial = Promise.withResolvers<string>();
    let cursorReads = 0;
    const notifier = new PollingSyncNotifier(
      adapterWithCursor(() => {
        cursorReads += 1;
        return initial.promise;
      }),
      10
    );

    const firstSubscription = notifier.subscribe(() => undefined);
    const secondSubscription = notifier.subscribe(() => undefined);

    expect(cursorReads).toBe(1);
    initial.resolve("0");
    const [first, second] = await Promise.all([firstSubscription, secondSubscription]);
    await first.unsubscribe();
    await second.unsubscribe();
  });

  test("keeps only one cursor poll in flight", async () => {
    const pendingPoll = Promise.withResolvers<string>();
    let cursorReads = 0;
    const notifier = new PollingSyncNotifier(
      adapterWithCursor(() => {
        cursorReads += 1;
        return cursorReads === 1 ? Promise.resolve("0") : pendingPoll.promise;
      }),
      1
    );
    const subscription = await notifier.subscribe(() => undefined);

    await Bun.sleep(10);
    const readsWhilePending = cursorReads;
    await subscription.unsubscribe();
    pendingPoll.resolve("1");

    expect(readsWhilePending).toBe(2);
  });

  test("does not overwrite a publication with an older in-flight poll", async () => {
    const pendingPoll = Promise.withResolvers<string>();
    let cursorReads = 0;
    const notifier = new PollingSyncNotifier(
      adapterWithCursor(() => {
        cursorReads += 1;
        return cursorReads === 1 ? Promise.resolve("0") : pendingPoll.promise;
      }),
      1
    );
    const received: string[] = [];
    const subscription = await notifier.subscribe((cursor) => {
      received.push(cursor);
    });
    for (let attempt = 0; attempt < 20 && cursorReads < 2; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: wait for the recursive poll to start.
      await Bun.sleep(1);
    }

    await notifier.publish("2");
    pendingPoll.resolve("1");
    await Promise.resolve();
    await Promise.resolve();
    await subscription.unsubscribe();

    expect(received).toEqual(["2"]);
  });
});
