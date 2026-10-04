/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { act } from "react";
import type { DevtoolsServerEvent, DevtoolsSnapshot } from "../../../src/devtools/protocol.ts";
import type { BrowserEventFor } from "../../../src/shared/browser-events.ts";
import { installDom, uninstallDom } from "../../support/dom.ts";

function installDashboardBrowserEvents(): void {
  Reflect.set(window, Symbol.for("furin.browser-events.runtime"), {
    subscribe: () => () => undefined,
    subscribeStatus: (listener: (status: string) => void) => {
      listener("connected");
      return () => undefined;
    },
  });
}

function validSnapshot(): DevtoolsSnapshot {
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
    sessionId: "dashboard-session",
    sync: { changesPath: null, enabled: false },
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
  installDashboardBrowserEvents();
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

test.serial(
  "snapshot refresh preserves newer events delivered by the shared transport",
  async () => {
    installDom();
    try {
      const { mergeDevtoolsSnapshotEvents } = await import("../../../src/devtools/dashboard.tsx");
      const serverEvent = {
        id: 1,
        instanceId: "dashboard-test",
        revision: 1,
        sessionId: "dashboard-session",
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
  }
);

test.serial("snapshot refresh keeps only the newest resources for each browser", async () => {
  installDom();
  try {
    const { mergeDevtoolsSnapshotEvents } = await import("../../../src/devtools/dashboard.tsx");
    const resourceEvent = {
      clientId: "browser",
      clientTimestamp: 1,
      id: 1,
      instanceId: "dashboard-test",
      resources: [],
      sessionId: "dashboard-session",
      timestamp: 1,
      type: "browser.resources",
      version: 2,
    } satisfies DevtoolsServerEvent;
    const snapshot = {
      ...validSnapshot(),
      events: [resourceEvent],
      lastEventId: 1,
    } as DevtoolsSnapshot;

    const merged = mergeDevtoolsSnapshotEvents(
      [{ ...resourceEvent, clientTimestamp: 2, id: 2, timestamp: 2 }],
      snapshot
    );
    expect(merged.map((event) => event.id)).toEqual([2]);
  } finally {
    await uninstallDom();
  }
});

test.serial(
  "snapshot refresh resets IDs for a new session of the same logical instance",
  async () => {
    installDom();
    try {
      const { mergeDevtoolsSnapshotEvents } = await import("../../../src/devtools/dashboard.tsx");
      const oldEvent = {
        id: 99,
        instanceId: "dashboard-test",
        revision: 1,
        sessionId: "old-session",
        timestamp: 1,
        type: "dev.ready",
        version: 2,
      } satisfies DevtoolsServerEvent;
      const newEvent = {
        ...oldEvent,
        id: 1,
        sessionId: "new-session",
      } satisfies DevtoolsServerEvent;
      const snapshot = {
        ...validSnapshot(),
        events: [newEvent],
        lastEventId: 1,
        sessionId: "new-session",
      } satisfies DevtoolsSnapshot;

      expect(mergeDevtoolsSnapshotEvents([oldEvent], snapshot)).toEqual([newEvent]);
    } finally {
      await uninstallDom();
    }
  }
);

test.serial(
  "reconnect resets the session and accepts low live IDs without old-session corruption",
  async () => {
    installDom();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const responses: Array<(response: Response) => void> = [];
    window.fetch = (() =>
      new Promise<Response>((resolve) => responses.push(resolve))) as unknown as typeof fetch;
    let deliver = (_event: BrowserEventFor<"devtools">): void => undefined;
    let status = (_status: string): void => undefined;
    Reflect.set(window, Symbol.for("furin.browser-events.runtime"), {
      subscribe: (_channel: string, listener: typeof deliver) => {
        deliver = listener;
        return () => undefined;
      },
      subscribeStatus: (listener: typeof status) => {
        status = listener;
        listener("connected");
        return () => undefined;
      },
    });
    const requestEvent = (id: number, sessionId: string, path: string): DevtoolsServerEvent => ({
      durationMs: 1,
      id,
      instanceId: "dashboard-test",
      operationId: null,
      path,
      requestId: path,
      sessionId,
      status: 200,
      timestamp: id,
      type: "request.finished",
      version: 2,
    });
    const original = {
      ...validSnapshot(),
      events: [requestEvent(99, "dashboard-session", "/old")],
      lastEventId: 99,
    };
    const recovered = {
      ...validSnapshot(),
      events: [requestEvent(1, "new-session", "/recovered")],
      lastEventId: 1,
      sessionId: "new-session",
    };
    const element = document.createElement("div");
    document.body.append(element);
    const { mountDevtoolsDashboard } = await import("../../../src/devtools/dashboard.tsx");
    let unmount = (): void => undefined;
    try {
      await act(async () => {
        unmount = mountDevtoolsDashboard(element);
        await Bun.sleep(0);
      });
      await act(async () => {
        responses.shift()?.(Response.json(original));
        await Bun.sleep(0);
      });
      await act(async () => {
        element.querySelector<HTMLButtonElement>('[data-tab="requests"]')?.click();
        await Bun.sleep(0);
      });
      expect(element.textContent).toContain("/old");
      // An older refresh can resolve after recovery; it must not restore the old session.
      await act(async () => {
        element.querySelector<HTMLButtonElement>(".topbar button")?.click();
        status("reconnecting");
        status("connected");
        await Bun.sleep(0);
      });
      expect(responses).toHaveLength(2);
      await act(async () => {
        deliver({
          channel: "devtools",
          data: requestEvent(2, "new-session", "/in-flight"),
          version: 1,
        });
        responses.pop()?.(Response.json(recovered));
        await Bun.sleep(0);
      });
      expect(element.textContent).toContain("/in-flight");
      await act(async () => {
        deliver({ channel: "devtools", data: requestEvent(3, "new-session", "/live"), version: 1 });
        deliver({
          channel: "devtools",
          data: requestEvent(100, "dashboard-session", "/delayed"),
          version: 1,
        });
        responses.shift()?.(Response.json(original));
        await Bun.sleep(0);
      });
      expect(element.textContent).toContain("/recovered");
      expect(element.textContent).toContain("/live");
      expect(element.textContent).not.toContain("/old");
      expect(element.textContent).not.toContain("/delayed");
      await act(async () => {
        element.querySelector<HTMLButtonElement>(".topbar button")?.click();
        deliver({
          channel: "devtools",
          data: requestEvent(4, "new-session", "/newer-live"),
          version: 1,
        });
        responses.shift()?.(Response.json(recovered));
        await Bun.sleep(0);
      });
      expect(element.textContent).toContain("/live");
      expect(element.textContent).toContain("/newer-live");
    } finally {
      await act(async () => unmount());
      Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      await uninstallDom();
    }
  }
);

test.serial("a failed snapshot refresh does not strand same-session live events", async () => {
  installDom();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  let rejectRefresh: ((error: Error) => void) | undefined;
  let requests = 0;
  window.fetch = (() => {
    requests += 1;
    return requests === 1
      ? Promise.resolve(Response.json(validSnapshot()))
      : new Promise<Response>((_resolve, reject) => {
          rejectRefresh = reject;
        });
  }) as unknown as typeof fetch;
  let deliver = (_event: BrowserEventFor<"devtools">): void => undefined;
  Reflect.set(window, Symbol.for("furin.browser-events.runtime"), {
    subscribe: (_channel: string, listener: typeof deliver) => {
      deliver = listener;
      return () => undefined;
    },
    subscribeStatus: (listener: (status: string) => void) => {
      listener("connected");
      return () => undefined;
    },
  });
  const element = document.createElement("div");
  document.body.append(element);
  const { mountDevtoolsDashboard } = await import("../../../src/devtools/dashboard.tsx");
  let unmount = (): void => undefined;
  try {
    await act(async () => {
      unmount = mountDevtoolsDashboard(element);
      await Bun.sleep(0);
    });
    await act(async () => {
      element.querySelector<HTMLButtonElement>('[data-tab="requests"]')?.click();
      element.querySelector<HTMLButtonElement>(".topbar button")?.click();
      await Bun.sleep(0);
      deliver({
        channel: "devtools",
        data: {
          durationMs: 1,
          id: 1,
          instanceId: "dashboard-test",
          operationId: null,
          path: "/live-during-failure",
          requestId: "live",
          sessionId: "dashboard-session",
          status: 200,
          timestamp: 1,
          type: "request.finished",
          version: 2,
        },
        version: 1,
      });
      rejectRefresh?.(new Error("snapshot unavailable"));
      await Bun.sleep(0);
    });
    expect(element.textContent).toContain("/live-during-failure");
  } finally {
    await act(async () => unmount());
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    await uninstallDom();
  }
});
