import type { BrowserEventChannel, BrowserEventEnvelope } from "../shared/browser-events.ts";

type BrowserEventListener = (event: BrowserEventEnvelope) => void;
type BrowserEventConnectionStatus = "connected" | "connecting" | "reconnecting" | "unauthorized";

interface BrowserEventRuntime {
  setSyncAuthentication: (authorized: boolean) => void;
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
  context?: unknown;
  cursor?: unknown;
}

export function installBrowserEventsRuntime(
  browser: Window,
  moduleUrlValue: string,
  transport?: "sse",
  sync?: boolean
): void {
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
      const data = candidate.data as SyncEventCandidate;
      return typeof data.cursor === "string" || data.context === "changed";
    }
    return candidate.channel === "diagnostic" || candidate.channel === "devtools";
  };

  const eventsUrl = (): URL => {
    const moduleUrl = new URL(moduleUrlValue);
    const prefix =
      moduleUrl.pathname.endsWith(clientSuffix) &&
      (moduleUrl.protocol === "http:" || moduleUrl.protocol === "https:")
        ? moduleUrl.pathname.slice(0, -clientSuffix.length)
        : "";
    const url = new URL(`${prefix}/_furin/events`, browser.location.href);
    return url;
  };

  const socketUrl = (): string => {
    const url = eventsUrl();
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
  let eventSource: EventSource | undefined;
  let status: BrowserEventConnectionStatus = "connecting";
  let suspended = false;
  let authPaused = false;
  let authorized = !sync;
  let authenticating: AbortController | undefined;

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

  const onMessageData = (data: unknown): void => {
    if (typeof data !== "string") {
      return;
    }
    try {
      const event: unknown = JSON.parse(data);
      if (isEnvelope(event)) {
        dispatch(event);
      }
    } catch {
      // A malformed framework event must never affect the application.
    }
  };

  const retry = (): void => {
    if (suspended || authPaused || reconnectTimer !== undefined) {
      return;
    }
    updateStatus("reconnecting");
    const baseDelay = Math.min(250 * 2 ** reconnectAttempt, maxReconnectDelayMs);
    const delay =
      transport === "sse"
        ? baseDelay
        : Math.min(Math.round(baseDelay * (0.8 + Math.random() * 0.4)), maxReconnectDelayMs);
    reconnectAttempt += 1;
    reconnectTimer = browser.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const authenticate = async (): Promise<void> => {
    if (authenticating) {
      return;
    }
    const current = new AbortController();
    authenticating = current;
    try {
      const response = await browser.fetch(eventsUrl(), {
        method: "HEAD",
        credentials: "same-origin",
        cache: "no-store",
        signal: current.signal,
      });
      if (current.signal.aborted) {
        return;
      }
      if (response.status === 401 || response.status === 403) {
        dispatch({ channel: "sync", data: { context: "changed" }, version: protocolVersion });
        setSyncAuthentication(false);
        return;
      }
      if (!response.ok) {
        throw new Error(`Sync authentication failed: ${response.status}`);
      }
      authorized = true;
      connect();
    } catch {
      if (!current.signal.aborted) {
        retry();
      }
    } finally {
      if (authenticating === current) {
        authenticating = undefined;
      }
    }
  };

  const connect = (): void => {
    if (suspended || authPaused) {
      return;
    }
    if (!authorized) {
      authenticate();
      return;
    }
    if (transport === "sse") {
      if (
        suspended ||
        (eventSource !== undefined && eventSource.readyState !== runtimeWindow.EventSource.CLOSED)
      ) {
        return;
      }
      const connection = new runtimeWindow.EventSource(eventsUrl().href);
      eventSource = connection;
      connection.addEventListener("open", () => {
        reconnectAttempt = 0;
        updateStatus("connected");
      });
      // This listener belongs to our same-origin EventSource, not window.postMessage.
      // react-doctor-disable-next-line react-doctor/postmessage-origin-risk
      connection.addEventListener("message", (message) => onMessageData(message.data));
      connection.addEventListener("error", () => {
        if (eventSource !== connection || suspended) {
          return;
        }
        updateStatus("reconnecting");
        if (
          connection.readyState !== runtimeWindow.EventSource.CLOSED ||
          reconnectTimer !== undefined
        ) {
          return;
        }
        eventSource = undefined;
        authorized = !sync;
        retry();
      });
      return;
    }
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
    // This listener belongs to our same-host WebSocket, not window.postMessage.
    // react-doctor-disable-next-line react-doctor/postmessage-origin-risk
    connection.addEventListener("message", (message) => onMessageData(message.data));
    connection.addEventListener("close", () => {
      if (socket !== connection) {
        return;
      }
      socket = undefined;
      if (suspended || reconnectTimer !== undefined) {
        return;
      }
      authorized = !sync;
      retry();
    });
    connection.addEventListener("error", () => connection.close());
  };

  const suspend = (): void => {
    suspended = true;
    authenticating?.abort();
    authenticating = undefined;
    authorized = !sync;
    if (reconnectTimer !== undefined) {
      browser.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    socket?.close();
    socket = undefined;
    eventSource?.close();
    eventSource = undefined;
  };
  const resume = (): void => {
    if (authPaused) {
      return;
    }
    suspended = false;
    if (socket === undefined && eventSource === undefined) {
      updateStatus("connecting");
    }
    connect();
  };
  const setSyncAuthentication = (valid: boolean): void => {
    if (valid) {
      if (authPaused) {
        authPaused = false;
        resume();
      }
    } else if (!authPaused) {
      authPaused = true;
      suspend();
      updateStatus("unauthorized");
    }
  };
  browser.addEventListener("pagehide", suspend);
  browser.addEventListener("pageshow", resume);
  connect();

  runtimeWindow[runtimeKey] = {
    setSyncAuthentication,
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

export function browserEventsClientSource(sync?: boolean): string {
  return `(${installBrowserEventsRuntime.toString()})(window, import.meta.url, undefined, ${sync === true});\n`;
}

export function browserEventsSseClientSource(): string {
  return `(${installBrowserEventsRuntime.toString()})(window, import.meta.url, "sse", true);\n`;
}
