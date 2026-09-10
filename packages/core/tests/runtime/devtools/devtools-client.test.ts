import { expect, test } from "bun:test";
import { installDom, uninstallDom, waitForDom } from "../../support/dom.ts";

const TestRuntimeEvent = Event;

class TestEventSource extends EventTarget {
  static readonly instances: TestEventSource[] = [];
  readonly url: string;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    TestEventSource.instances.push(this);
  }

  close(): void {
    // The test stream owns no external resources.
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
    sync: { enabled: false, streamPath: null },
    version: 2,
  };
}

function cleanupDevtoolsRuntime(): void {
  const runtime = Reflect.get(window, Symbol.for("furin.devtools.runtime")) as
    | { cleanup?: () => void }
    | undefined;
  runtime?.cleanup?.();
  Reflect.deleteProperty(window, Symbol.for("furin.devtools.runtime"));
}

test.serial(
  "DevTools collector mounts only a compact launcher for the dedicated page",
  async () => {
    installDom();
    const originalFetch = window.fetch;
    const originalEventSource = window.EventSource;
    const originalEntries = performance.getEntriesByType.bind(performance);
    window.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve(
        url.includes("/snapshot") ? Response.json(snapshot()) : new Response(null, { status: 204 })
      );
    }) as typeof fetch;
    window.EventSource = TestEventSource as unknown as typeof EventSource;
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
      window.EventSource = originalEventSource;
      performance.getEntriesByType = originalEntries;
      await uninstallDom();
    }
  }
);

test.serial("DevTools collector correlates only the exact same-origin data endpoint", async () => {
  installDom();
  const calls: Array<{ init?: RequestInit; input: RequestInfo | URL }> = [];
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ init, input });
    return Promise.resolve(
      String(input).includes("/snapshot")
        ? Response.json(snapshot())
        : new Response(null, { status: 204 })
    );
  }) as typeof fetch;
  window.EventSource = TestEventSource as unknown as typeof EventSource;
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

test.serial(
  "DevTools collector does not patch the application after invalid startup data",
  async () => {
    installDom();
    const originalFetch = (() =>
      Promise.resolve(Response.json({ ...snapshot(), version: 999 }))) as unknown as typeof fetch;
    const originalEventSource = TestEventSource as unknown as typeof EventSource;
    window.fetch = originalFetch;
    window.EventSource = originalEventSource;

    try {
      await import(`../../../src/devtools/collector.ts?invalid=${Date.now()}`);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(document.querySelector("furin-devtools-launcher")).toBeNull();
      expect(window.fetch).toBe(originalFetch);
      expect(window.EventSource).toBe(originalEventSource);
    } finally {
      cleanupDevtoolsRuntime();
      await uninstallDom();
    }
  }
);

test.serial("DevTools resource reporting ignores its own ingest requests", async () => {
  installDom();
  const originalObserver = globalThis.PerformanceObserver;
  const originalEntries = performance.getEntriesByType.bind(performance);
  let browserEventRequests = 0;
  window.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/browser-events")) {
      browserEventRequests += 1;
    }
    return Promise.resolve(
      url.includes("/snapshot") ? Response.json(snapshot()) : new Response(null, { status: 204 })
    );
  }) as typeof fetch;
  window.EventSource = TestEventSource as unknown as typeof EventSource;
  performance.getEntriesByType = (() => []) as typeof performance.getEntriesByType;
  globalThis.PerformanceObserver = TestPerformanceObserver as unknown as typeof PerformanceObserver;

  try {
    await import(`../../../src/devtools/collector.ts?resources=${Date.now()}`);
    await waitForDom(() => document.querySelector("furin-devtools-launcher") !== null, undefined);
    const requestCount = browserEventRequests;
    TestPerformanceObserver.callback?.(
      {
        getEntries: () => [
          {
            name: "http://localhost/_furin/devtools/browser-events",
          } as PerformanceEntry,
        ],
      } as PerformanceObserverEntryList,
      {} as PerformanceObserver
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(browserEventRequests).toBe(requestCount);
  } finally {
    cleanupDevtoolsRuntime();
    globalThis.PerformanceObserver = originalObserver;
    performance.getEntriesByType = originalEntries;
    await uninstallDom();
  }
});

test.serial("DevTools freezes watcher cycle IDs for each native update", async () => {
  installDom();
  TestEventSource.instances.length = 0;
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
  window.EventSource = TestEventSource as unknown as typeof EventSource;
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
    const event = new TestRuntimeEvent("furin.devtools");
    Object.defineProperty(event, "data", {
      value: JSON.stringify({
        changedModule: "src/pages/index.tsx",
        cycleId,
        detectedAt,
        id,
        instanceId: "test-instance",
        timestamp: Date.now(),
        type: "hmr.cycle.started",
        version: 2,
      }),
    });
    TestEventSource.instances.at(-1)?.dispatchEvent(event);
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
      ["before-update", null],
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
