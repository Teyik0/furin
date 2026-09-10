import { expect, test } from "bun:test";
import {
  browserEventsClientSource,
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
    runtime?.subscribe("sync", (event) => received.push(event));
    runtime?.subscribe("diagnostic", (event) => received.push(event));
    runtime?.subscribe("devtools", (event) => received.push(event));

    expect(TestWebSocket.instances).toHaveLength(1);
    const [socket] = TestWebSocket.instances;
    socket?.open();
    socket?.receive({ channel: "sync", data: { cursor: "42" }, version: 1 });

    expect(received).toEqual([{ channel: "sync", data: { cursor: "42" }, version: 1 }]);
    expect(socket?.url).toBe("ws://localhost:3000/_furin/events");

    const replayed: BrowserEventEnvelope[] = [];
    runtime?.subscribe("sync", (event) => replayed.push(event));
    expect(replayed).toEqual([{ channel: "sync", data: { cursor: "42" }, version: 1 }]);

    socket?.serverClose();
    await Bun.sleep(350);
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
  const transpiler = new Bun.Transpiler({ loader: "js" });

  expect(() => transpiler.transformSync(source)).not.toThrow();
  expect(source).toContain("(window, import.meta.url)");
  expect(source).not.toContain("browser-events-client");
});
