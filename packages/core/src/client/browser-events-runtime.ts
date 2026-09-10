import type { BrowserEventChannel, BrowserEventEnvelope } from "../shared/browser-events.ts";

type BrowserEventListener = (event: BrowserEventEnvelope) => void;
type BrowserEventConnectionStatus = "connected" | "connecting" | "reconnecting";

interface BrowserEventRuntime {
  subscribe: (
    channel: BrowserEventChannel,
    listener: BrowserEventListener
  ) => () => boolean | undefined;
  subscribeStatus: (listener: (status: BrowserEventConnectionStatus) => void) => () => boolean;
}

interface BrowserEventCandidate {
  channel?: unknown;
  data?: unknown;
  version?: unknown;
}

interface SyncEventCandidate {
  cursor?: unknown;
}

export function installBrowserEventsRuntime(browser: Window, moduleUrlValue: string): void {
  const runtimeKey = Symbol.for("furin.browser-events.runtime");
  const runtimeWindow = browser as Window &
    typeof globalThis & {
      [key: symbol]: BrowserEventRuntime | undefined;
    };
  if (runtimeWindow[runtimeKey]) {
    return;
  }

  const protocolVersion = 1;
  const clientSuffix = "/_furin/events/client.js";
  const maxDevtoolsEvents = 1000;
  const maxReconnectDelayMs = 5000;

  const isEnvelope = (value: unknown): value is BrowserEventEnvelope => {
    if (value === null || typeof value !== "object") {
      return false;
    }
    const candidate = value as BrowserEventCandidate;
    if (
      candidate.version !== protocolVersion ||
      candidate.data === null ||
      typeof candidate.data !== "object"
    ) {
      return false;
    }
    if (candidate.channel === "sync") {
      return typeof (candidate.data as SyncEventCandidate).cursor === "string";
    }
    return candidate.channel === "diagnostic" || candidate.channel === "devtools";
  };

  const socketUrl = (): string => {
    const moduleUrl = new URL(moduleUrlValue);
    const prefix =
      moduleUrl.pathname.endsWith(clientSuffix) &&
      (moduleUrl.protocol === "http:" || moduleUrl.protocol === "https:")
        ? moduleUrl.pathname.slice(0, -clientSuffix.length)
        : "";
    const url = new URL(`${prefix}/_furin/events`, browser.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
  };

  const listeners = {
    devtools: new Set<BrowserEventListener>(),
    diagnostic: new Set<BrowserEventListener>(),
    sync: new Set<BrowserEventListener>(),
  };
  const statusListeners = new Set<(status: BrowserEventConnectionStatus) => void>();
  const buffered: { [K in BrowserEventChannel]: BrowserEventEnvelope[] } = {
    devtools: [],
    diagnostic: [],
    sync: [],
  };
  let reconnectAttempt = 0;
  let reconnectTimer: number | undefined;
  let socket: WebSocket | undefined;
  let status: BrowserEventConnectionStatus = "connecting";
  let suspended = false;

  const updateStatus = (next: BrowserEventConnectionStatus): void => {
    if (status === next) {
      return;
    }
    status = next;
    for (const listener of statusListeners) {
      listener(status);
    }
  };

  const buffer = (event: BrowserEventEnvelope): void => {
    const events = buffered[event.channel];
    events.push(event);
    const limit = event.channel === "devtools" ? maxDevtoolsEvents : 1;
    if (events.length > limit) {
      events.splice(0, events.length - limit);
    }
  };

  const dispatch = (event: BrowserEventEnvelope): void => {
    const channelListeners = listeners[event.channel];
    if (event.channel !== "devtools" || channelListeners.size === 0) {
      buffer(event);
    }
    for (const listener of channelListeners) {
      listener(event);
    }
  };

  const connect = (): void => {
    if (
      suspended ||
      socket?.readyState === runtimeWindow.WebSocket.CONNECTING ||
      socket?.readyState === runtimeWindow.WebSocket.OPEN
    ) {
      return;
    }
    const connection = new runtimeWindow.WebSocket(socketUrl());
    socket = connection;
    connection.addEventListener("open", () => {
      reconnectAttempt = 0;
      updateStatus("connected");
    });
    connection.addEventListener("message", (message) => {
      if (typeof message.data !== "string") {
        return;
      }
      try {
        const event: unknown = JSON.parse(message.data);
        if (isEnvelope(event)) {
          dispatch(event);
        }
      } catch {
        // A malformed framework event must never affect the application.
      }
    });
    connection.addEventListener("close", () => {
      if (socket !== connection) {
        return;
      }
      socket = undefined;
      if (suspended || reconnectTimer !== undefined) {
        return;
      }
      updateStatus("reconnecting");
      const baseDelay = Math.min(250 * 2 ** reconnectAttempt, maxReconnectDelayMs);
      const delay = Math.min(
        Math.round(baseDelay * (0.8 + Math.random() * 0.4)),
        maxReconnectDelayMs
      );
      reconnectAttempt += 1;
      reconnectTimer = browser.setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    });
    connection.addEventListener("error", () => connection.close());
  };

  const suspend = (): void => {
    suspended = true;
    if (reconnectTimer !== undefined) {
      browser.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    socket?.close();
    socket = undefined;
  };
  const resume = (): void => {
    suspended = false;
    connect();
  };
  browser.addEventListener("pagehide", suspend);
  browser.addEventListener("pageshow", resume);
  connect();

  runtimeWindow[runtimeKey] = {
    subscribe(channel, listener) {
      const channelListeners = listeners[channel];
      channelListeners.add(listener);
      for (const event of buffered[channel]) {
        listener(event);
      }
      return () => channelListeners.delete(listener);
    },
    subscribeStatus(listener) {
      statusListeners.add(listener);
      listener(status);
      return () => statusListeners.delete(listener);
    },
  };
}

export function browserEventsClientSource(): string {
  return `(${installBrowserEventsRuntime.toString()})(window, import.meta.url);\n`;
}
