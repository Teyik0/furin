import { expect, test } from "bun:test";
import { installDom, uninstallDom, waitForDom } from "../../support/dom.ts";

const BROWSER_EVENTS_RUNTIME_KEY = Symbol.for("furin.browser-events.runtime");

interface TestBrowserEventEnvelope {
  channel: "devtools" | "sync";
  data: unknown;
  version: 1;
}

class TestBrowserEventRuntime {
  readonly listeners = new Map<
    TestBrowserEventEnvelope["channel"],
    Set<(event: TestBrowserEventEnvelope) => void>
  >();
  readonly statusListeners = new Set<(status: string) => void>();
  status = "connected";

  emit(data: unknown): void {
    this.emitChannel("devtools", data);
  }

  emitChannel(channel: TestBrowserEventEnvelope["channel"], data: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) {
      listener({ channel, data, version: 1 });
    }
  }

  subscribe(channel: string, listener: (event: TestBrowserEventEnvelope) => void): () => void {
    if (channel !== "devtools" && channel !== "sync") {
      return () => undefined;
    }
    const listeners = this.listeners.get(channel) ?? new Set();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
    return () => listeners.delete(listener);
  }

  subscribeStatus(listener: (status: string) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  updateStatus(status: string): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}

class TestPerformanceObserver {
  static callback: PerformanceObserverCallback | undefined;

  constructor(callback: PerformanceObserverCallback) {
    TestPerformanceObserver.callback = callback;
  }

  disconnect(): void {
    // The test observer owns no external resources.
  }

  observe(): void {
    // Entries are dispatched explicitly by the test.
  }

  takeRecords(): PerformanceEntryList {
    return [];
  }
}

function installBrowserEventRuntime(): TestBrowserEventRuntime {
  const browserEvents = new TestBrowserEventRuntime();
  (window as typeof window & { [key: symbol]: TestBrowserEventRuntime })[
    BROWSER_EVENTS_RUNTIME_KEY
  ] = browserEvents;
  return browserEvents;
}

function snapshot(): object {
  return {
    caches: [],
    events: [],
    instance: { id: "test-instance", prefix: "" },
    lastEventId: 0,
    routes: [],
    runtime: {
      graph: { edges: 0, modules: 0, revision: 0 },
      memory: { heapBytes: 1024, rssBytes: 2048 },
    },
    sync: { changesPath: null, enabled: false },
    version: 2,
  };
}

function cleanupDevtoolsRuntime(): void {
  const runtimeKey = Symbol.for("furin.devtools.runtime");
  const runtimeState = (
    window as typeof window & {
      [key: symbol]: { cleanup?: () => void };
    }
  )[runtimeKey];
  runtimeState?.cleanup?.();
  Reflect.deleteProperty(window, runtimeKey);
  Reflect.deleteProperty(window, BROWSER_EVENTS_RUNTIME_KEY);
}

test.serial(
  "DevTools collector mounts only a compact launcher for the dedicated page",
  async () => {
    installDom();
    const originalFetch = window.fetch;
    const originalEntries = performance.getEntriesByType.bind(performance);
    installBrowserEventRuntime();
    window.fetch = ((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).includes("/snapshot")
          ? Response.json(snapshot())
          : new Response(null, { status: 204 })
      )) as typeof fetch;
    performance.getEntriesByType = (() => []) as typeof performance.getEntriesByType;

    try {
      await import(`../../../src/devtools/collector.ts?launcher=${Date.now()}`);
      await waitForDom(() => document.querySelector("furin-devtools-launcher") !== null, undefined);
      const launcher = document.querySelector("furin-devtools-launcher");

      expect(launcher?.shadowRoot?.querySelector("a")?.getAttribute("href")).toBe(
        "/_furin/devtools"
      );
      expect(launcher?.shadowRoot?.textContent).not.toContain("Runtime overview");
    } finally {
      cleanupDevtoolsRuntime();
      window.fetch = originalFetch;
      performance.getEntriesByType = originalEntries;
      await uninstallDom();
    }
  }
);

test.serial("DevTools collector correlates only the exact same-origin data endpoint", async () => {
  installDom();
  installBrowserEventRuntime();
  const calls: Array<{ init?: RequestInit; input: RequestInfo | URL }> = [];
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ init, input });
    return Promise.resolve(
      String(input).includes("/snapshot")
        ? Response.json(snapshot())
        : new Response(null, { status: 204 })
    );
  }) as typeof fetch;
  performance.getEntriesByType = (() => []) as typeof performance.getEntriesByType;

  try {
    await import(`../../../src/devtools/collector.ts?fetch=${Date.now()}`);
    await waitForDom(() => document.querySelector("furin-devtools-launcher") !== null, undefined);
    await window.fetch("https://api.example/_furin/data");
    await window.fetch("/other/_furin/data");
    await window.fetch("/_furin/data?path=/dashboard");

    const observed = calls.slice(-3);
    expect(new Headers(observed[0]?.init?.headers).has("x-furin-devtools-operation-id")).toBe(
      false
    );
    expect(new Headers(observed[1]?.init?.headers).has("x-furin-devtools-operation-id")).toBe(
      false
    );
    expect(new Headers(observed[2]?.init?.headers).has("x-furin-devtools-operation-id")).toBe(true);
  } finally {
    cleanupDevtoolsRuntime();
    await uninstallDom();
  }
});

test.serial("DevTools observes sync on the shared browser event transport", async () => {
  installDom();
  const sharedEvents = installBrowserEventRuntime();
  const postedEvents: Array<{
    clientId?: string;
    clientTimestamp?: number;
    cursor?: string | null;
    state?: string;
    type: string;
  }> = [];
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/snapshot")) {
      return Promise.resolve(
        Response.json({
          ...snapshot(),
          sync: { changesPath: "/_furin/sync/changes", enabled: true },
        })
      );
    }
    if (typeof init?.body === "string") {
      postedEvents.push(JSON.parse(init.body));
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  performance.getEntriesByType = (() => []) as typeof performance.getEntriesByType;

  try {
    await import(`../../../src/devtools/collector.ts?sync=${Date.now()}`);
    await waitForDom(() => document.querySelector("furin-devtools-launcher") !== null, undefined);
    sharedEvents.updateStatus("reconnecting");
    sharedEvents.emitChannel("sync", { cursor: "42" });

    expect(postedEvents).toContainEqual({
      clientId: expect.any(String),
      clientTimestamp: expect.any(Number),
      cursor: null,
      state: "reconnecting",
      type: "sync.connection.changed",
    });
    expect(postedEvents).toContainEqual({
      clientId: expect.any(String),
      clientTimestamp: expect.any(Number),
      cursor: "42",
      state: "connected",
      type: "sync.connection.changed",
    });
  } finally {
    cleanupDevtoolsRuntime();
    await uninstallDom();
  }
});

test.serial(
  "DevTools collector does not patch the application after invalid startup data",
  async () => {
    installDom();
    installBrowserEventRuntime();
    const originalFetch = (() =>
      Promise.resolve(Response.json({ ...snapshot(), version: 999 }))) as unknown as typeof fetch;
    window.fetch = originalFetch;

    try {
      await import(`../../../src/devtools/collector.ts?invalid=${Date.now()}`);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(document.querySelector("furin-devtools-launcher")).toBeNull();
      expect(window.fetch).toBe(originalFetch);
    } finally {
      cleanupDevtoolsRuntime();
      await uninstallDom();
    }
  }
);

test.serial("DevTools resource reporting ignores its own ingest requests", async () => {
  installDom();
  installBrowserEventRuntime();
  const originalObserver = globalThis.PerformanceObserver;
  const originalEntries = performance.getEntriesByType.bind(performance);
  let browserEventRequests = 0;
  let reportedResources = 0;
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/browser-events")) {
      browserEventRequests += 1;
      if (typeof init?.body === "string") {
        const event = JSON.parse(init.body);
        if (event.type === "browser.resources") {
          reportedResources = event.resources.length;
        }
      }
    }
    return Promise.resolve(
      url.includes("/snapshot") ? Response.json(snapshot()) : new Response(null, { status: 204 })
    );
  }) as typeof fetch;
  performance.getEntriesByType = (() =>
    Array.from(
      { length: 501 },
      (_, index) =>
        ({
          decodedBodySize: index,
          duration: index,
          encodedBodySize: index,
          initiatorType: "script",
          name: `http://localhost:3000/assets/${index}.js`,
          transferSize: index,
        }) as PerformanceResourceTiming
    )) as typeof performance.getEntriesByType;
  globalThis.PerformanceObserver = TestPerformanceObserver as unknown as typeof PerformanceObserver;

  try {
    await import(`../../../src/devtools/collector.ts?resources=${Date.now()}`);
    await waitForDom(() => document.querySelector("furin-devtools-launcher") !== null, undefined);
    const requestCount = browserEventRequests;
    TestPerformanceObserver.callback?.(
      {
        getEntries: () => [
          {
            name: "http://localhost:3000/_furin/devtools/browser-events",
          } as PerformanceEntry,
        ],
      } as PerformanceObserverEntryList,
      {} as PerformanceObserver
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(browserEventRequests).toBe(requestCount);
    expect(reportedResources).toBe(500);
  } finally {
    cleanupDevtoolsRuntime();
    globalThis.PerformanceObserver = originalObserver;
    performance.getEntriesByType = originalEntries;
    await uninstallDom();
  }
});

test.serial("DevTools freezes watcher cycle IDs for each native update", async () => {
  installDom();
  const sharedEvents = installBrowserEventRuntime();
  const originalEntries = performance.getEntriesByType.bind(performance);
  const originalSendBeacon = navigator.sendBeacon;
  const browserEvents: Array<{
    cycleId?: string | null;
    phase?: string;
    type: string;
  }> = [];
  const beacons: Blob[] = [];
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") {
      browserEvents.push(JSON.parse(init.body));
    }
    return Promise.resolve(
      String(input).includes("/snapshot")
        ? Response.json(snapshot())
        : new Response(null, { status: 204 })
    );
  }) as typeof fetch;
  performance.getEntriesByType = (() => []) as typeof performance.getEntriesByType;
  navigator.sendBeacon = ((_url: string | URL, data?: BodyInit | null) => {
    if (data instanceof Blob) {
      beacons.push(data);
    }
    return true;
  }) as typeof navigator.sendBeacon;

  const dispatchHmr = (phase: string, reason: string | null): void => {
    window.dispatchEvent(
      new CustomEvent("furin:hmr", {
        detail: {
          durationMs: null,
          module: null,
          phase,
          reason,
          state: null,
        },
      })
    );
  };
  const dispatchCycle = (cycleId: string, detectedAt: number, id: number): void => {
    sharedEvents.emit({
      changedModule: "src/pages/index.tsx",
      cycleId,
      detectedAt,
      id,
      instanceId: "test-instance",
      timestamp: Date.now(),
      type: "hmr.cycle.started",
      version: 2,
    });
  };

  try {
    await import(`../../../src/devtools/collector.ts?cycles=${Date.now()}`);
    await waitForDom(() => document.querySelector("furin-devtools-launcher") !== null, undefined);

    dispatchHmr("before-update", null);
    dispatchCycle("cycle-a", Date.now() - 1, 1);
    dispatchCycle("cycle-b", Date.now() + 100, 2);
    dispatchHmr("after-update", null);
    dispatchHmr("paint", null);
    dispatchHmr("before-update", null);
    dispatchHmr("after-update", null);
    dispatchHmr("full-reload", "development-error-recovered");

    const phases = browserEvents.filter((event) => event.type === "hmr.client.phase");
    expect(phases.map((event) => [event.phase, event.cycleId])).toEqual([
      ["before-update", "cycle-a"],
      ["after-update", "cycle-a"],
      ["paint", "cycle-a"],
      ["before-update", "cycle-b"],
      ["after-update", "cycle-b"],
    ]);
    const beaconEvent = JSON.parse((await beacons.at(-1)?.text()) ?? "{}");
    expect(beaconEvent).toMatchObject({
      reason: "development-error-recovered",
      type: "hmr.full-reload",
    });
  } finally {
    cleanupDevtoolsRuntime();
    navigator.sendBeacon = originalSendBeacon;
    performance.getEntriesByType = originalEntries;
    await uninstallDom();
  }
});
