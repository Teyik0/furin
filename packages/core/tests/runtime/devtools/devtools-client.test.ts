import { expect, test } from "bun:test";
import { installDom, uninstallDom, waitForDom } from "../../support/dom.ts";

const TestRuntimeEvent = Event;

class TestEventSource extends EventTarget {
  static readonly CLOSED = 2;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly instances: TestEventSource[] = [];

  readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly readyState = 1;
  readonly url: string;
  readonly withCredentials = false;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    TestEventSource.instances.push(this);
  }

  close(): void {
    // The test stream has no resources to release.
  }
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
}

test.serial(
  "native DevTools opens in Shadow DOM and the shortcut hides and restores it",
  async () => {
    installDom();
    const originalFetch = window.fetch;
    const originalEventSource = window.EventSource;
    const originalGetEntriesByType = performance.getEntriesByType.bind(performance);
    window.fetch = (() =>
      Promise.resolve(
        Response.json({
          caches: [],
          events: [],
          instance: { id: "test-instance", prefix: "" },
          lastEventId: 0,
          routes: [],
          sync: { enabled: false, streamPath: null },
          version: 1,
        })
      )) as unknown as typeof window.fetch;
    window.EventSource = TestEventSource as unknown as typeof EventSource;
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
      window.EventSource = originalEventSource;
      performance.getEntriesByType = originalGetEntriesByType;
      await uninstallDom();
    }
  }
);

test.serial(
  "native DevTools leaves browser globals untouched when startup validation fails",
  async () => {
    installDom();
    const rejectedFetch = (() =>
      Promise.resolve(new Response(null, { status: 404 }))) as unknown as typeof window.fetch;
    const originalEventSource = TestEventSource as unknown as typeof EventSource;
    window.fetch = rejectedFetch;
    window.EventSource = originalEventSource;

    try {
      await import(`../../../src/devtools/devtools-element.js?failed=${Date.now()}`);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(window.fetch).toBe(rejectedFetch);
      expect(window.EventSource).toBe(originalEventSource);
      expect(document.querySelector("furin-devtools")).toBeNull();
    } finally {
      cleanupDevtoolsRuntime();
      await uninstallDom();
    }
  }
);

test.serial("native DevTools only correlates the exact same-origin data endpoint", async () => {
  installDom();
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
        sync: { enabled: false, streamPath: null },
        version: 1,
      })
    );
  }) as typeof window.fetch;
  window.fetch = testFetch;
  window.EventSource = TestEventSource as unknown as typeof EventSource;
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
          sync: { enabled: false, streamPath: null },
          version: 1,
        })
      )) as unknown as typeof window.fetch;
    class ThrowingEventSource {
      constructor() {
        throw new Error("EventSource unavailable");
      }
    }
    const originalEventSource = ThrowingEventSource as unknown as typeof EventSource;
    window.fetch = testFetch;
    window.EventSource = originalEventSource;
    performance.getEntriesByType = (() => []) as typeof performance.getEntriesByType;

    try {
      await import(`../../../src/devtools/devtools-element.js?rollback=${Date.now()}`);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(window.fetch).toBe(testFetch);
      expect(window.EventSource).toBe(originalEventSource);
    } finally {
      cleanupDevtoolsRuntime();
      await uninstallDom();
    }
  }
);

test.serial("native DevTools rejects malformed same-origin snapshots and SSE events", async () => {
  installDom();
  TestEventSource.instances.length = 0;
  const snapshot = {
    caches: [],
    events: [],
    instance: { id: "validation-test", prefix: "" },
    lastEventId: 0,
    routes: [],
    sync: { enabled: false, streamPath: null },
    version: 1,
  };
  window.fetch = (() => Promise.resolve(Response.json(snapshot))) as unknown as typeof window.fetch;
  window.EventSource = TestEventSource as unknown as typeof EventSource;
  performance.getEntriesByType = (() => []) as typeof performance.getEntriesByType;

  try {
    await import(`../../../src/devtools/devtools-element.js?validation=${Date.now()}`);
    await waitForDom(() => document.querySelector("furin-devtools") !== null, undefined);
    const source = TestEventSource.instances.at(-1);
    expect(source).toBeDefined();
    const maliciousEvent = new TestRuntimeEvent("furin.devtools");
    Object.defineProperty(maliciousEvent, "data", {
      value: JSON.stringify({
        cache: "isr-loader",
        id: 1,
        instanceId: "validation-test",
        operationId: null,
        outcome: 'hit"><img src=x onerror=alert(1)>',
        path: "/",
        requestId: "request",
        timestamp: Date.now(),
        type: "cache.access",
        version: 1,
      }),
    });
    source?.dispatchEvent(maliciousEvent);

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
  window.EventSource = TestEventSource as unknown as typeof EventSource;
  try {
    await import(`../../../src/devtools/devtools-element.js?bad-snapshot=${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector("furin-devtools")).toBeNull();
  } finally {
    cleanupDevtoolsRuntime();
    await uninstallDom();
  }
});
