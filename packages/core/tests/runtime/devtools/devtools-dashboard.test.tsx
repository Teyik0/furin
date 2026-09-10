/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { act } from "react";
import type { DevtoolsServerEvent, DevtoolsSnapshot } from "../../../src/devtools/protocol.ts";
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

async function waitForDashboard(element: HTMLElement, deadline: number): Promise<void> {
  await act(async () => {
    await Bun.sleep(50);
  });
  if (element.textContent.includes("Hot module replacement")) {
    return;
  }
  if (Date.now() >= deadline) {
    throw new Error("Timed out waiting for the dashboard to recover");
  }
  return waitForDashboard(element, deadline);
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
    await waitForDashboard(element, Date.now() + 10_000);

    expect(requests).toBeGreaterThanOrEqual(2);
    expect(element.textContent).toContain("Hot module replacement");
  } finally {
    await act(async () => unmount());
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    await uninstallDom();
  }
});

test.serial("snapshot refresh preserves newer events already delivered over SSE", async () => {
  installDom();
  try {
    const { mergeDevtoolsSnapshotEvents } = await import("../../../src/devtools/dashboard.tsx");
    const serverEvent = {
      id: 1,
      instanceId: "dashboard-test",
      revision: 1,
      timestamp: 1,
      type: "dev.ready",
      version: 2,
    } satisfies DevtoolsServerEvent;
    const liveEvent = {
      ...serverEvent,
      id: 2,
      revision: 2,
      timestamp: 2,
    } satisfies DevtoolsServerEvent;
    const snapshot = {
      ...validSnapshot(),
      events: [serverEvent],
      lastEventId: 1,
    } as DevtoolsSnapshot;

    expect(mergeDevtoolsSnapshotEvents([liveEvent], snapshot).map((event) => event.id)).toEqual([
      1, 2,
    ]);
  } finally {
    await uninstallDom();
  }
});
