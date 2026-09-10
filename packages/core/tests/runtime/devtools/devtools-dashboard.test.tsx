/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom } from "../../support/dom.ts";

class DashboardEventSource extends EventTarget {
  constructor(_url: string | URL) {
    super();
  }

  close(): void {
    // The test stream owns no external resources.
  }
}

function validSnapshot(): object {
  return {
    caches: [],
    events: [],
    instance: { id: "dashboard-test", prefix: "" },
    lastEventId: 0,
    routes: [],
    runtime: {
      graph: { edges: 0, modules: 0, revision: 0 },
      memory: { heapBytes: 1024, rssBytes: 2048 },
    },
    sync: { enabled: false, streamPath: null },
    version: 2,
  };
}

test.serial("the dashboard recovers when its initial snapshot request fails", async () => {
  installDom();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  let requests = 0;
  window.fetch = (() => {
    requests += 1;
    return requests === 1
      ? Promise.reject(new Error("server restarting"))
      : Promise.resolve(Response.json(validSnapshot()));
  }) as unknown as typeof fetch;
  window.EventSource = DashboardEventSource as unknown as typeof EventSource;
  const element = document.createElement("div");
  document.body.append(element);
  const { mountDevtoolsDashboard } = await import(
    `../../../src/devtools/dashboard.tsx?recovery=${Date.now()}`
  );
  let unmount = (): void => undefined;

  try {
    await act(async () => {
      unmount = mountDevtoolsDashboard(element);
      await Bun.sleep(0);
    });
    await act(async () => {
      await Bun.sleep(650);
    });

    expect(requests).toBeGreaterThanOrEqual(2);
    expect(element.textContent).toContain("Hot module replacement");
  } finally {
    await act(async () => unmount());
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    await uninstallDom();
  }
});
