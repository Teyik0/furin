import { expect, test } from "bun:test";
import {
  browserEventsClientSource,
  browserEventsSseClientSource,
  installBrowserEventsRuntime,
} from "../../../src/client/browser-events-runtime.ts";
import { installDom, uninstallDom } from "../../support/dom.ts";

const RUNTIME_KEY = Symbol.for("furin.browser-events.runtime");
const TestRuntimeEvent = Event;
const TestRuntimeMessageEvent = MessageEvent;

interface BrowserEventEnvelope {
  channel: "diagnostic" | "devtools" | "sync";
  data: unknown;
  version: 1;
}

interface BrowserEventRuntime {
  subscribe: (
    channel: BrowserEventEnvelope["channel"],
    listener: (event: BrowserEventEnvelope) => void
  ) => () => void;
  subscribeStatus: (listener: (status: string) => void) => () => void;
}

class TestWebSocket extends EventTarget {
  static readonly CLOSED = 3;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly instances: TestWebSocket[] = [];

  readonly url: string;
  readyState = TestWebSocket.CONNECTING;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    TestWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = TestWebSocket.CLOSED;
  }

  serverClose(): void {
    this.readyState = TestWebSocket.CLOSED;
    this.dispatchEvent(new TestRuntimeEvent("close"));
  }

  open(): void {
    this.readyState = TestWebSocket.OPEN;
    this.dispatchEvent(new TestRuntimeEvent("open"));
  }

  receive(event: BrowserEventEnvelope): void {
    this.dispatchEvent(new TestRuntimeMessageEvent("message", { data: JSON.stringify(event) }));
  }
}

class TestEventSource extends EventTarget {
  static readonly CLOSED = 2;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly instances: TestEventSource[] = [];

  readonly url: string;
  readyState = TestEventSource.CONNECTING;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    TestEventSource.instances.push(this);
  }

  close(): void {
    this.readyState = TestEventSource.CLOSED;
  }

  open(): void {
    this.readyState = TestEventSource.OPEN;
    this.dispatchEvent(new TestRuntimeEvent("open"));
  }

  receive(event: BrowserEventEnvelope): void {
    this.dispatchEvent(new TestRuntimeMessageEvent("message", { data: JSON.stringify(event) }));
  }

  disconnect(): void {
    this.readyState = TestEventSource.CONNECTING;
    this.dispatchEvent(new TestRuntimeEvent("error"));
  }

  fail(): void {
    this.readyState = TestEventSource.CLOSED;
    this.dispatchEvent(new TestRuntimeEvent("error"));
  }
}

test.serial("SSE reconnects after the stream closes permanently", async () => {
  installDom();
  TestEventSource.instances.length = 0;
  const originalEventSource = window.EventSource;
  window.EventSource = TestEventSource as unknown as typeof EventSource;
  try {
    installBrowserEventsRuntime(window, "https://example.com/_furin/events/client.js", "sse");
    const [first] = TestEventSource.instances;
    first?.open();
    first?.fail();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(TestEventSource.instances).toHaveLength(2);
    expect(TestEventSource.instances[1]?.url).toBe(first?.url);
  } finally {
    window.dispatchEvent(new window.Event("pagehide"));
    Reflect.deleteProperty(window, RUNTIME_KEY);
    window.EventSource = originalEventSource;
    await uninstallDom();
  }
});

test.serial("SSE browser events reconnect and keep the sync subscription", async () => {
  installDom();
  TestEventSource.instances.length = 0;
  const originalEventSource = window.EventSource;
  window.EventSource = TestEventSource as unknown as typeof EventSource;

  try {
    installBrowserEventsRuntime(window, "https://example.com/admin/_furin/events/client.js", "sse");
    const runtime = (window as typeof window & { [RUNTIME_KEY]?: BrowserEventRuntime })[
      RUNTIME_KEY
    ];
    const received: BrowserEventEnvelope[] = [];
    const statuses: string[] = [];
    runtime?.subscribe("sync", (event) => received.push(event));
    runtime?.subscribeStatus((status) => statuses.push(status));

    const [source] = TestEventSource.instances;
    expect(source?.url).toBe("http://localhost:3000/admin/_furin/events");
    source?.open();
    source?.receive({ channel: "sync", data: { cursor: "7" }, version: 1 });
    source?.disconnect();
    source?.open();
    source?.receive({ channel: "sync", data: { cursor: "8" }, version: 1 });

    expect(received.map((event) => event.data)).toEqual([{ cursor: "7" }, { cursor: "8" }]);
    expect(statuses).toEqual(["connecting", "connected", "reconnecting", "connected"]);
    expect(TestEventSource.instances).toHaveLength(1);

    window.dispatchEvent(new window.Event("pagehide"));
    window.dispatchEvent(new window.Event("pageshow"));
    expect(TestEventSource.instances).toHaveLength(2);
  } finally {
    window.dispatchEvent(new window.Event("pagehide"));
    Reflect.deleteProperty(window, RUNTIME_KEY);
    window.EventSource = originalEventSource;
    await uninstallDom();
  }
});

test.serial("browser event consumers share one multiplexed connection", async () => {
  installDom();
  TestWebSocket.instances.length = 0;
  const originalWebSocket = window.WebSocket;
  window.WebSocket = TestWebSocket as unknown as typeof WebSocket;

  try {
    installBrowserEventsRuntime(window, "http://localhost:3000/_furin/events/client.js");
    const runtime = (window as typeof window & { [RUNTIME_KEY]?: BrowserEventRuntime })[
      RUNTIME_KEY
    ];
    expect(runtime).toBeDefined();

    const received: BrowserEventEnvelope[] = [];
    const statuses: string[] = [];
    runtime?.subscribeStatus((status) => statuses.push(status));
    runtime?.subscribe("sync", (event) => received.push(event));
    runtime?.subscribe("diagnostic", (event) => received.push(event));
    runtime?.subscribe("devtools", (event) => received.push(event));

    expect(TestWebSocket.instances).toHaveLength(1);
    const [socket] = TestWebSocket.instances;
    socket?.open();
    socket?.receive({ channel: "sync", data: { cursor: "42" }, version: 1 });

    expect(received).toEqual([{ channel: "sync", data: { cursor: "42" }, version: 1 }]);
    expect(socket?.url).toBe("ws://localhost:3000/_furin/events");
    expect(statuses).toEqual(["connecting", "connected"]);

    const replayed: BrowserEventEnvelope[] = [];
    runtime?.subscribe("sync", (event) => replayed.push(event));
    expect(replayed).toEqual([{ channel: "sync", data: { cursor: "42" }, version: 1 }]);

    socket?.serverClose();
    expect(statuses.at(-1)).toBe("reconnecting");
    await Bun.sleep(1000);
    expect(TestWebSocket.instances).toHaveLength(2);
  } finally {
    window.dispatchEvent(new window.Event("pagehide"));
    Reflect.deleteProperty(window, RUNTIME_KEY);
    window.WebSocket = originalWebSocket;
    await uninstallDom();
  }
});

test.serial("browser event status returns to connecting when a cached page resumes", async () => {
  installDom();
  TestWebSocket.instances.length = 0;
  const originalWebSocket = window.WebSocket;
  window.WebSocket = TestWebSocket as unknown as typeof WebSocket;

  try {
    installBrowserEventsRuntime(window, "http://localhost:3000/_furin/events/client.js");
    const runtime = (window as typeof window & { [RUNTIME_KEY]?: BrowserEventRuntime })[
      RUNTIME_KEY
    ];
    const statuses: string[] = [];
    runtime?.subscribeStatus((status) => statuses.push(status));
    TestWebSocket.instances[0]?.open();

    window.dispatchEvent(new window.Event("pagehide"));
    window.dispatchEvent(new window.Event("pageshow"));

    expect(statuses).toEqual(["connecting", "connected", "connecting"]);
    expect(TestWebSocket.instances).toHaveLength(2);
  } finally {
    window.dispatchEvent(new window.Event("pagehide"));
    Reflect.deleteProperty(window, RUNTIME_KEY);
    window.WebSocket = originalWebSocket;
    await uninstallDom();
  }
});

test("browser event client source is a self-contained module", () => {
  const source = browserEventsClientSource();
  const sseSource = browserEventsSseClientSource();
  const transpiler = new Bun.Transpiler({ loader: "js" });

  expect(() => transpiler.transformSync(source)).not.toThrow();
  expect(() => transpiler.transformSync(sseSource)).not.toThrow();
  expect(source).toContain("(window, import.meta.url)");
  expect(sseSource).toContain('(window, import.meta.url, "sse")');
  expect(source).not.toContain("browser-events-client");
});
