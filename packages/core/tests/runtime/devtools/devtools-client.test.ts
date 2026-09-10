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

function installBrowserEventRuntime(): TestBrowserEventRuntime {
  const browserEvents = new TestBrowserEventRuntime();
  (window as typeof window & { [key: symbol]: TestBrowserEventRuntime })[
    BROWSER_EVENTS_RUNTIME_KEY
  ] = browserEvents;
  return browserEvents;
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
  "native DevTools opens in Shadow DOM and the shortcut hides and restores it",
  async () => {
    installDom();
    const originalFetch = window.fetch;
    const originalGetEntriesByType = performance.getEntriesByType.bind(performance);
    installBrowserEventRuntime();
    window.fetch = (() =>
      Promise.resolve(
        Response.json({
          caches: [],
          events: [],
          instance: { id: "test-instance", prefix: "" },
          lastEventId: 0,
          routes: [],
          sync: { changesPath: null, enabled: false },
          version: 2,
        })
      )) as unknown as typeof window.fetch;
    performance.getEntriesByType = (() => []) as typeof performance.getEntriesByType;

    try {
      await import(`../../../src/devtools/devtools-element.js?test=${Date.now()}`);
      await waitForDom(() => document.querySelector("furin-devtools") !== null, undefined);
      const element = document.querySelector("furin-devtools");
      const root = element?.shadowRoot;

      expect(root).not.toBeNull();
      root?.querySelector<HTMLButtonElement>('[data-action="toggle"]')?.click();
      expect(root?.textContent).toContain("Runtime overview");

      const panel = root?.querySelector(".panel");
      root?.querySelector<HTMLButtonElement>('[data-tab="routes"]')?.click();
      expect(root?.querySelector(".panel")).toBe(panel);
      expect(root?.querySelector("main")?.textContent).toContain(
        "Discovered files and rendering modes."
      );

      const runtimeState = (
        window as typeof window & {
          [key: symbol]: {
            browserState?: {
              bundleEntries: Array<{
                decodedBytes: number;
                durationMs: number;
                encodedBytes: number;
                name: string;
                transferredBytes: number;
                type: string;
              }>;
            };
          };
        }
      )[Symbol.for("furin.devtools.runtime")];
      expect(runtimeState?.browserState).toBeDefined();
      expect(runtimeState?.browserState?.bundleEntries).toEqual([]);

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "Period",
          ctrlKey: true,
          key: ">",
          shiftKey: true,
        })
      );
      expect(root?.innerHTML).toContain(":host{display:none}");

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "Period",
          ctrlKey: true,
          key: ">",
          shiftKey: true,
        })
      );
      expect(root?.textContent).toContain("DevTools");
    } finally {
      cleanupDevtoolsRuntime();
      window.fetch = originalFetch;
      performance.getEntriesByType = originalGetEntriesByType;
      await uninstallDom();
    }
  }
);

test.serial("native DevTools observes sync on the shared browser event transport", async () => {
  installDom();
  const browserEvents = installBrowserEventRuntime();
  window.fetch = (() =>
    Promise.resolve(
      Response.json({
        caches: [],
        events: [],
        instance: { id: "sync-test", prefix: "" },
        lastEventId: 0,
        routes: [],
        sync: { changesPath: "/_furin/sync/changes", enabled: true },
        version: 2,
      })
    )) as unknown as typeof window.fetch;
  performance.getEntriesByType = (() => []) as typeof performance.getEntriesByType;

  try {
    await import(`../../../src/devtools/devtools-element.js?sync=${Date.now()}`);
    await waitForDom(() => document.querySelector("furin-devtools") !== null, undefined);

    const root = document.querySelector("furin-devtools")?.shadowRoot;
    root?.querySelector<HTMLButtonElement>('[data-action="toggle"]')?.click();
    root?.querySelector<HTMLButtonElement>('[data-tab="sync"]')?.click();

    expect(root?.querySelector("main")?.textContent).toContain("connected");
    browserEvents.emitChannel("sync", { cursor: "42" });

    expect(root?.querySelector("main")?.textContent).toContain("42");
    expect(root?.querySelector("main")?.textContent).toContain("connected");
    browserEvents.updateStatus("reconnecting");
    expect(root?.querySelector("main")?.textContent).toContain("reconnecting");
  } finally {
    cleanupDevtoolsRuntime();
    await uninstallDom();
  }
});

test.serial(
  "native DevTools leaves browser globals untouched when startup validation fails",
  async () => {
    installDom();
    const rejectedFetch = (() =>
      Promise.resolve(new Response(null, { status: 404 }))) as unknown as typeof window.fetch;
    window.fetch = rejectedFetch;

    try {
      await import(`../../../src/devtools/devtools-element.js?failed=${Date.now()}`);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(window.fetch).toBe(rejectedFetch);
      expect(document.querySelector("furin-devtools")).toBeNull();
    } finally {
      cleanupDevtoolsRuntime();
      await uninstallDom();
    }
  }
);

test.serial("native DevTools only correlates the exact same-origin data endpoint", async () => {
  installDom();
  installBrowserEventRuntime();
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const testFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ init, input });
    return Promise.resolve(
      Response.json({
        caches: [],
        events: [],
        instance: { id: "origin-test", prefix: "" },
        lastEventId: 0,
        routes: [],
        sync: { changesPath: null, enabled: false },
        version: 2,
      })
    );
  }) as typeof window.fetch;
  window.fetch = testFetch;
  performance.getEntriesByType = (() => []) as typeof performance.getEntriesByType;

  try {
    await import(`../../../src/devtools/devtools-element.js?origin=${Date.now()}`);
    await waitForDom(() => document.querySelector("furin-devtools") !== null, undefined);

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
  "native DevTools rolls back browser patches when startup fails after installation",
  async () => {
    installDom();
    const testFetch = (() =>
      Promise.resolve(
        Response.json({
          caches: [],
          events: [],
          instance: { id: "rollback-test", prefix: "" },
          lastEventId: 0,
          routes: [],
          sync: { changesPath: null, enabled: false },
          version: 2,
        })
      )) as unknown as typeof window.fetch;
    const unavailableBrowserEvents = {
      subscribe() {
        throw new Error("Browser event transport unavailable");
      },
    };
    window.fetch = testFetch;
    (window as typeof window & { [key: symbol]: typeof unavailableBrowserEvents })[
      BROWSER_EVENTS_RUNTIME_KEY
    ] = unavailableBrowserEvents;
    performance.getEntriesByType = (() => []) as typeof performance.getEntriesByType;

    try {
      await import(`../../../src/devtools/devtools-element.js?rollback=${Date.now()}`);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(window.fetch).toBe(testFetch);
    } finally {
      cleanupDevtoolsRuntime();
      await uninstallDom();
    }
  }
);

test.serial("native DevTools rejects malformed snapshots and browser events", async () => {
  installDom();
  const browserEvents = installBrowserEventRuntime();
  const snapshot = {
    caches: [],
    events: [],
    instance: { id: "validation-test", prefix: "" },
    lastEventId: 0,
    routes: [],
    sync: { changesPath: null, enabled: false },
    version: 2,
  };
  window.fetch = (() => Promise.resolve(Response.json(snapshot))) as unknown as typeof window.fetch;
  performance.getEntriesByType = (() => []) as typeof performance.getEntriesByType;

  try {
    await import(`../../../src/devtools/devtools-element.js?validation=${Date.now()}`);
    await waitForDom(() => document.querySelector("furin-devtools") !== null, undefined);
    browserEvents.emit({
      cache: "isr-loader",
      id: 1,
      instanceId: "validation-test",
      operationId: null,
      outcome: 'hit"><img src=x onerror=alert(1)>',
      path: "/",
      requestId: "request",
      timestamp: Date.now(),
      type: "cache.access",
      version: 2,
    });

    const root = document.querySelector("furin-devtools")?.shadowRoot;
    root?.querySelector<HTMLButtonElement>('[data-action="toggle"]')?.click();
    expect(root?.textContent).toContain("0 events");
    expect(root?.querySelector("img")).toBeNull();
  } finally {
    cleanupDevtoolsRuntime();
    await uninstallDom();
  }

  installDom();
  window.fetch = (() =>
    Promise.resolve(
      Response.json({
        ...snapshot,
        routes: [
          {
            file: "page.tsx",
            hasLoader: false,
            hasRequestLoader: false,
            mode: 'ssr"><img src=x onerror=alert(1)>',
            pattern: "/",
            tags: [],
          },
        ],
      })
    )) as unknown as typeof window.fetch;
  try {
    await import(`../../../src/devtools/devtools-element.js?bad-snapshot=${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector("furin-devtools")).toBeNull();
  } finally {
    cleanupDevtoolsRuntime();
    await uninstallDom();
  }
});
