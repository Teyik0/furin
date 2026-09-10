import { describe, expect, test } from "bun:test";
import { createDevDiagnostic, DevDiagnosticStore } from "../../../src/server/dev/diagnostics.ts";
import type { DevDiagnostic } from "../../../src/shared/dev-diagnostics.ts";

const diagnostic: DevDiagnostic = {
  cause: undefined,
  frames: [],
  importChain: ["src/pages/index.tsx"],
  location: { column: 1, file: "src/pages/index.tsx", line: 1 },
  message: "broken",
  phase: "render",
  route: "/",
  stack: undefined,
};

describe("DevDiagnosticStore", () => {
  test("replays healthy state from a restarted server", () => {
    const store = new DevDiagnosticStore();

    const subscription = store.subscribe(42, "previous-server", () => undefined);

    expect(subscription.replay).toHaveLength(1);
    expect(subscription.replay[0]?.type).toBe("ready");
    subscription.unsubscribe();
  });

  test("replays the latest ready state to a reconnecting browser", () => {
    const store = new DevDiagnosticStore();
    store.publish(diagnostic);
    const ready = store.markReady("/");
    if (!ready) {
      throw new Error("Expected the matching route to publish ready state");
    }

    const subscription = store.subscribe(0, undefined, () => undefined);

    expect(subscription.replay).toEqual([ready]);
    subscription.unsubscribe();
  });

  test("does not clear a diagnostic when another route succeeds", () => {
    const store = new DevDiagnosticStore();
    const active = store.publish({ ...diagnostic, route: "/broken" });

    expect(store.markReady("/healthy")).toBeUndefined();
    const subscription = store.subscribe(0, undefined, () => undefined);
    expect(subscription.replay).toEqual([active]);
    subscription.unsubscribe();
  });

  test("replays the current error after a server restart", () => {
    const store = new DevDiagnosticStore();
    const active = store.publish(diagnostic);

    const subscription = store.subscribe(42, "previous-server", () => undefined);

    expect(subscription.replay).toEqual([active]);
    subscription.unsubscribe();
  });

  test("replays incremental events for the same server", () => {
    const store = new DevDiagnosticStore();
    const initialSubscription = store.subscribe(0, undefined, () => undefined);
    const [initial] = initialSubscription.replay;
    initialSubscription.unsubscribe();
    if (!initial) {
      throw new Error("Expected the initial ready event");
    }
    const active = store.publish(diagnostic);

    const subscription = store.subscribe(initial.id, initial.serverId, () => undefined);

    expect(subscription.replay).toEqual([active]);
    subscription.unsubscribe();
  });

  test("deduplicates an unchanged active diagnostic", () => {
    const store = new DevDiagnosticStore();
    const first = store.publish(diagnostic);
    const second = store.publish(diagnostic);

    expect(second).toBe(first);
    expect(store.revision).toBe(0);
  });

  test("decodes file URL source locations", () => {
    const error = new Error("encoded path");
    Reflect.set(error, "position", {
      column: 2,
      file: "file:///workspace/src/card%20view.tsx",
      line: 3,
    });

    const result = createDevDiagnostic(error, {
      entryPath: "/workspace/src/page.tsx",
      importChain: ["/workspace/src/page.tsx", "/workspace/src/card view.tsx"],
      phase: "render",
      route: "/",
    });

    expect(result.location?.file).toEndWith("workspace/src/card view.tsx");
  });
});
