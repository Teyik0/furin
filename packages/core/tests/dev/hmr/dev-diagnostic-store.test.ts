import { describe, expect, test } from "bun:test";
import { DevDiagnosticStore } from "../../../src/server/dev/diagnostics.ts";
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
});
