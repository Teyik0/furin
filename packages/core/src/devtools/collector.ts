import {
  type DevtoolsBrowserEventInput,
  type DevtoolsBrowserEventPayload,
  type DevtoolsConnectionState,
  type DevtoolsFullReloadReason,
  type DevtoolsHmrClientPhase,
  type DevtoolsResource,
  type DevtoolsSnapshot,
  type DevtoolsSyncSnapshot,
  isDevtoolsServerEvent,
  isDevtoolsSnapshot,
} from "./protocol.ts";

const ELEMENT_NAME = "furin-devtools-launcher";
const DEVTOOLS_EVENT = "furin.devtools";
const HMR_EVENT = "furin:hmr";
const RUNTIME_KEY = Symbol.for("furin.devtools.runtime");

interface HmrRuntimeEvent {
  durationMs: number | null;
  module: string | null;
  phase:
    | "after-update"
    | "before-full-reload"
    | "before-update"
    | "connection"
    | "full-reload"
    | "module"
    | "paint";
  reason: string | null;
  state: DevtoolsConnectionState | null;
}

interface CollectorRuntime {
  cleanup: (() => void) | null;
  eventSource: typeof EventSource;
  fetch: typeof fetch;
}

interface HmrConnectionRuntime {
  disconnected: boolean;
  installed: boolean;
  state?: DevtoolsConnectionState;
}

type SendBrowserEvent = (input: DevtoolsBrowserEventPayload, beacon: boolean) => void;

function runtimeState(): CollectorRuntime {
  const existing = Reflect.get(window, RUNTIME_KEY);
  if (existing) {
    return existing as CollectorRuntime;
  }
  const state: CollectorRuntime = {
    cleanup: null,
    eventSource: window.EventSource,
    fetch: window.fetch,
  };
  Reflect.set(window, RUNTIME_KEY, state);
  return state;
}

const runtime = runtimeState();
const nativeFetch = runtime.fetch;
const NativeEventSource = runtime.eventSource;

function assetUrl(path: string): string {
  const source = new URL(import.meta.url);
  const marker = "/_furin/devtools/client.js";
  const prefix = source.pathname.endsWith(marker) ? source.pathname.slice(0, -marker.length) : "";
  return `${prefix}${path}`;
}

function clientId(): string {
  const key = "furin:devtools:client-id";
  const fallback = (): string =>
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) {
      return existing;
    }
    const created = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : fallback();
    sessionStorage.setItem(key, created);
    return created;
  } catch {
    return fallback();
  }
}

function hmrConnectionState(): DevtoolsConnectionState {
  const state = Reflect.get(window, "__FURIN_HMR_CONNECTION__") as HmrConnectionRuntime | undefined;
  return state?.state ?? (state?.disconnected ? "disconnected" : "connected");
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : String(input), window.location.href);
}

function launcherStatusColor(state: DevtoolsConnectionState): string {
  if (state === "connected") {
    return "#c9ff5c";
  }
  return state === "disconnected" ? "#ff655d" : "#ffc85c";
}

class FurinDevtoolsLauncher extends HTMLElement {
  readonly #root = this.attachShadow({ mode: "open" });
  #durationMs: number | null = null;
  #state: DevtoolsConnectionState = "connecting";

  connectedCallback(): void {
    this.render();
  }

  update(state: DevtoolsConnectionState, durationMs: number | null): void {
    this.#state = state;
    if (durationMs !== null) {
      this.#durationMs = durationMs;
    }
    this.render();
  }

  render(): void {
    const duration = this.#durationMs === null ? "" : `${Math.round(this.#durationMs)} ms`;
    this.#root.innerHTML = `<style>
      :host{all:initial;position:fixed;right:14px;bottom:14px;z-index:2147483646;font-family:"IBM Plex Mono","SFMono-Regular",Consolas,monospace}
      a{display:flex;align-items:center;gap:8px;min-height:34px;padding:0 11px 0 7px;border:1px solid rgba(255,255,255,.14);border-radius:7px;background:#11120f;color:#eceee5;box-shadow:0 10px 32px rgba(0,0,0,.28);font:600 11px/1 inherit;letter-spacing:-.01em;text-decoration:none}
      a:hover{border-color:rgba(201,255,92,.5);background:#171914}
      a:focus-visible{outline:2px solid #c9ff5c;outline-offset:3px}
      b{display:grid;width:22px;height:22px;place-items:center;border-radius:4px;background:#c9ff5c;color:#10110d;font-size:12px}
      i{width:6px;height:6px;border-radius:50%;background:var(--status);box-shadow:0 0 10px var(--status)}
      span:empty{display:none}
    </style>
    <a href="${assetUrl("/_furin/devtools")}" target="_blank" rel="noopener" aria-label="Open Furin DevTools">
      <b>F</b><i style="--status:${launcherStatusColor(this.#state)}"></i><span>${duration}</span>
    </a>`;
  }
}

function installFetchObserver(): () => void {
  const dataUrl = new URL(assetUrl("/_furin/data"), window.location.href);
  const observedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.origin !== dataUrl.origin || url.pathname !== dataUrl.pathname) {
      return nativeFetch.call(window, input, init);
    }
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    headers.set("x-furin-devtools-operation-id", crypto.randomUUID());
    return nativeFetch.call(window, input, { ...init, headers });
  }) as unknown as typeof window.fetch;
  window.fetch = observedFetch;
  return () => {
    if (window.fetch === observedFetch) {
      window.fetch = nativeFetch;
    }
  };
}

function browserResources(): DevtoolsResource[] {
  const resources: DevtoolsResource[] = [];
  for (const entry of performance.getEntriesByType("resource")) {
    const resource = entry as PerformanceResourceTiming;
    const url = new URL(resource.name, window.location.href);
    if (url.origin !== window.location.origin || url.pathname.includes("/_furin/devtools/")) {
      continue;
    }
    resources.push({
      decodedBytes: resource.decodedBodySize,
      durationMs: resource.duration,
      encodedBytes: resource.encodedBodySize,
      name: url.pathname,
      transferredBytes: resource.transferSize,
      type: resource.initiatorType || "resource",
    });
  }
  return resources
    .toSorted((left, right) => right.transferredBytes - left.transferredBytes)
    .slice(0, 500);
}

function installKeyboardShortcut(): () => void {
  const listener = (event: KeyboardEvent): void => {
    const { target } = event;
    const editable =
      target instanceof HTMLElement &&
      (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));
    if (
      !editable &&
      (event.code === "Period" || event.key === ".") &&
      event.shiftKey &&
      (event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault();
      window.open(assetUrl("/_furin/devtools"), "_blank", "noopener");
    }
  };
  window.addEventListener("keydown", listener);
  return () => window.removeEventListener("keydown", listener);
}

function installSyncObserver(sync: DevtoolsSyncSnapshot, send: SendBrowserEvent): () => void {
  if (!(sync.enabled && sync.streamPath)) {
    send(
      {
        cursor: null,
        state: "disabled",
        type: "sync.connection.changed",
      },
      false
    );
    return () => undefined;
  }
  const syncUrl = new URL(assetUrl(sync.streamPath), window.location.href);
  class ObservedEventSource extends NativeEventSource {
    constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
      super(url, eventSourceInitDict);
      const absolute = new URL(String(url), window.location.href);
      if (absolute.origin !== syncUrl.origin || absolute.pathname !== syncUrl.pathname) {
        return;
      }
      send(
        {
          cursor: null,
          state: "connecting",
          type: "sync.connection.changed",
        },
        false
      );
      this.addEventListener("open", () => {
        send(
          {
            cursor: null,
            state: "connected",
            type: "sync.connection.changed",
          },
          false
        );
      });
      this.addEventListener("error", () => {
        send(
          {
            cursor: null,
            state: "reconnecting",
            type: "sync.connection.changed",
          },
          false
        );
      });
      this.addEventListener("furin.sync", (event) => {
        let cursor: string | null = null;
        try {
          const payload: unknown = JSON.parse((event as MessageEvent<string>).data);
          if (payload !== null && typeof payload === "object") {
            const candidate = Reflect.get(payload, "cursor");
            cursor = typeof candidate === "string" ? candidate : null;
          }
        } catch {
          cursor = null;
        }
        send(
          {
            cursor,
            state: "connected",
            type: "sync.connection.changed",
          },
          false
        );
      });
    }
  }
  window.EventSource = ObservedEventSource;
  return () => {
    if (window.EventSource === ObservedEventSource) {
      window.EventSource = NativeEventSource;
    }
  };
}

function documentSyncSnapshot(): DevtoolsSyncSnapshot {
  const syncElement = document.getElementById("__FURIN_SYNC__");
  try {
    const value: unknown = JSON.parse(syncElement?.textContent ?? "{}");
    if (value !== null && typeof value === "object") {
      const streamPath = Reflect.get(value, "stream");
      if (typeof streamPath === "string") {
        return { enabled: true, streamPath };
      }
    }
  } catch {
    // The server snapshot remains the authoritative validation boundary.
  }
  return { enabled: false, streamPath: null };
}

async function start(): Promise<void> {
  const id = clientId();
  const cleanups: Array<() => void> = [];
  const send = (
    input: DevtoolsBrowserEventPayload,
    beacon: boolean,
    clientTimestamp?: number
  ): void => {
    const event = {
      ...input,
      clientId: id,
      clientTimestamp: clientTimestamp ?? performance.timeOrigin + performance.now(),
    } as DevtoolsBrowserEventInput;
    const body = JSON.stringify(event);
    const url = assetUrl("/_furin/devtools/browser-events");
    if (
      beacon &&
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))
    ) {
      return;
    }
    nativeFetch
      .call(window, url, {
        body,
        headers: { "content-type": "application/json" },
        keepalive: true,
        method: "POST",
      })
      .catch(() => undefined);
  };
  const hadActiveRuntime = runtime.cleanup !== null;
  if (!hadActiveRuntime) {
    cleanups.push(installSyncObserver(documentSyncSnapshot(), send));
  }
  let snapshot: DevtoolsSnapshot;
  try {
    const response = await nativeFetch.call(window, assetUrl("/_furin/devtools/snapshot"));
    const candidate: unknown = response.ok ? await response.json() : null;
    if (!isDevtoolsSnapshot(candidate)) {
      for (const dispose of cleanups.reverse()) {
        dispose();
      }
      return;
    }
    snapshot = candidate;
  } catch {
    for (const dispose of cleanups.reverse()) {
      dispose();
    }
    return;
  }

  runtime.cleanup?.();
  if (hadActiveRuntime) {
    cleanups.push(installSyncObserver(snapshot.sync, send));
  }
  const pendingCycles: Array<{ cycleId: string; detectedAt: number }> = [];
  let pendingBeforeUpdate:
    | {
        detail: HmrRuntimeEvent;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let currentCycleId: string | null = null;
  let lastCompletedAt = 0;
  let updateInProgress = false;
  let updateStartedAt: number | null = null;
  let updateStartedEpoch = 0;
  if (!customElements.get(ELEMENT_NAME)) {
    customElements.define(ELEMENT_NAME, FurinDevtoolsLauncher);
  }
  const launcher =
    document.querySelector<FurinDevtoolsLauncher>(ELEMENT_NAME) ??
    (document.createElement(ELEMENT_NAME) as FurinDevtoolsLauncher);

  const updateLauncher = (state: DevtoolsConnectionState, durationMs: number | null): void => {
    launcher.update(state, durationMs);
  };

  const sendFullReload = (detail: HmrRuntimeEvent): void => {
    let reason: DevtoolsFullReloadReason = "unknown-native-hmr-reason";
    if (detail.reason === "hmr-connection-recovered") {
      reason = "hmr-connection-recovered";
    } else if (detail.reason === "hmr-runtime-unavailable") {
      reason = "hmr-runtime-unavailable";
    } else if (detail.reason === "native-hmr-boundary-missing") {
      reason = "native-hmr-boundary-missing";
    } else if (detail.reason === "development-error-recovered") {
      reason = "development-error-recovered";
    }
    currentCycleId ??= pendingCycles.shift()?.cycleId ?? null;
    send(
      {
        cycleId: currentCycleId,
        reason,
        type: "hmr.full-reload",
      },
      true
    );
  };

  const sendClientPhase = (
    phase: DevtoolsHmrClientPhase,
    detail: HmrRuntimeEvent,
    clientTimestamp?: number
  ): void => {
    const durationMs =
      detail.durationMs ??
      (updateStartedAt === null ? null : Math.max(0, performance.now() - updateStartedAt));
    send(
      {
        cycleId: currentCycleId,
        durationMs,
        module: detail.module,
        phase,
        type: "hmr.client.phase",
      },
      false,
      clientTimestamp
    );
    if (phase === "paint") {
      updateLauncher("connected", durationMs);
      lastCompletedAt = performance.timeOrigin + performance.now();
      updateInProgress = false;
      updateStartedAt = null;
      currentCycleId = null;
    }
  };
  const flushBeforeUpdate = (): void => {
    if (!pendingBeforeUpdate) {
      return;
    }
    clearTimeout(pendingBeforeUpdate.timer);
    const { detail } = pendingBeforeUpdate;
    pendingBeforeUpdate = undefined;
    sendClientPhase("before-update", detail, updateStartedEpoch);
  };

  const hmrListener = (event: Event): void => {
    const { detail } = event as CustomEvent<HmrRuntimeEvent>;
    if (!detail) {
      return;
    }
    if (detail.phase === "connection" && detail.state !== null) {
      updateLauncher(detail.state, null);
      send({ state: detail.state, type: "hmr.connection.changed" }, false);
      return;
    }
    if (detail.phase === "before-update") {
      updateStartedAt = performance.now();
      updateStartedEpoch = performance.timeOrigin + updateStartedAt;
      updateInProgress = true;
      currentCycleId = pendingCycles.shift()?.cycleId ?? null;
      pendingBeforeUpdate = {
        detail,
        timer: setTimeout(flushBeforeUpdate, 20),
      };
      return;
    }
    if (detail.phase === "full-reload" || detail.phase === "before-full-reload") {
      flushBeforeUpdate();
      sendFullReload(detail);
      return;
    }
    const phase = detail.phase === "module" ? "after-update" : detail.phase;
    if (phase === "after-update" || phase === "paint") {
      flushBeforeUpdate();
      sendClientPhase(phase, detail);
    }
  };

  try {
    cleanups.push(installFetchObserver());
    cleanups.push(installKeyboardShortcut());
    window.addEventListener(HMR_EVENT, hmrListener);
    cleanups.push(() => window.removeEventListener(HMR_EVENT, hmrListener));

    if (!launcher.isConnected) {
      document.body.append(launcher);
      cleanups.push(() => launcher.remove());
    }
    const initialConnectionState = hmrConnectionState();
    updateLauncher(initialConnectionState, null);
    send({ state: initialConnectionState, type: "hmr.connection.changed" }, false);
    send({ resources: browserResources(), type: "browser.resources" }, false);

    if (typeof PerformanceObserver === "function") {
      let scheduled = false;
      const observer = new PerformanceObserver((entries) => {
        const includesApplicationResource = entries.getEntries().some((entry) => {
          const url = new URL(entry.name, window.location.href);
          return (
            url.origin === window.location.origin && !url.pathname.includes("/_furin/devtools/")
          );
        });
        if (scheduled || !includesApplicationResource) {
          return;
        }
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          send({ resources: browserResources(), type: "browser.resources" }, false);
        });
      });
      observer.observe({ entryTypes: ["resource"] });
      cleanups.push(() => observer.disconnect());
    }

    const source = new NativeEventSource(
      `${assetUrl("/_furin/devtools/events")}?after=${snapshot.lastEventId}`
    );
    cleanups.push(() => source.close());
    source.addEventListener(DEVTOOLS_EVENT, (event) => {
      try {
        const payload: unknown = JSON.parse((event as MessageEvent<string>).data);
        if (!isDevtoolsServerEvent(payload) || payload.instanceId !== snapshot.instance.id) {
          return;
        }
        if (payload.type === "hmr.cycle.started" && payload.detectedAt > lastCompletedAt) {
          if (
            updateInProgress &&
            currentCycleId === null &&
            payload.detectedAt <= updateStartedEpoch + 10
          ) {
            currentCycleId = payload.cycleId;
            flushBeforeUpdate();
            return;
          }
          pendingCycles.push({
            cycleId: payload.cycleId,
            detectedAt: payload.detectedAt,
          });
          if (pendingCycles.length > 50) {
            pendingCycles.shift();
          }
        }
      } catch {
        // A malformed development event must never affect the application.
      }
    });

    runtime.cleanup = () => {
      if (pendingBeforeUpdate) {
        clearTimeout(pendingBeforeUpdate.timer);
      }
      for (const dispose of cleanups.reverse()) {
        dispose();
      }
      runtime.cleanup = null;
    };
  } catch {
    for (const dispose of cleanups.reverse()) {
      dispose();
    }
  }
}

start().catch(() => undefined);
