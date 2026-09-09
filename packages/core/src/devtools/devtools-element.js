const ELEMENT_NAME = "furin-devtools";
const PROTOCOL_VERSION = 1;
const DEVTOOLS_EVENT = "furin.devtools";
const MAX_BROWSER_EVENTS = 200;
const RUNTIME_KEY = Symbol.for("furin.devtools.runtime");
const runtime =
  window[RUNTIME_KEY] ??
  (window[RUNTIME_KEY] = {
    cleanup: null,
    eventSource: window.EventSource,
    fetch: window.fetch,
  });
const nativeFetch = runtime.fetch;
const NativeEventSource = runtime.eventSource;
const browserState =
  runtime.browserState ??
  (runtime.browserState = {
    bundleEntries: [],
    operations: [],
    syncEvents: [],
    syncStatus: "disabled",
  });

function assetUrl(path) {
  const source = new URL(import.meta.url);
  const marker = "/_furin/devtools/client.js";
  const prefix = source.pathname.endsWith(marker) ? source.pathname.slice(0, -marker.length) : "";
  return `${prefix}${path}`;
}

function pushBounded(collection, value) {
  collection.push(value);
  if (collection.length > MAX_BROWSER_EVENTS) {
    collection.shift();
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isServerEvent(event) {
  if (
    !(isObject(event) && Number.isSafeInteger(event.id)) ||
    typeof event.instanceId !== "string" ||
    !Number.isFinite(event.timestamp) ||
    event.version !== PROTOCOL_VERSION
  ) {
    return false;
  }
  if (event.type === "cache.access") {
    return (
      ["isr-loader", "ssg-loader"].includes(event.cache) &&
      ["hit", "miss", "stale"].includes(event.outcome) &&
      typeof event.path === "string"
    );
  }
  if (event.type === "cache.invalidated") {
    return (
      typeof event.deleted === "boolean" &&
      Number.isSafeInteger(event.purgedPaths) &&
      ["path", "source", "tag"].includes(event.reason) &&
      typeof event.target === "string"
    );
  }
  if (event.type === "loader.finished") {
    return (
      Number.isFinite(event.durationMs) &&
      isStringArray(event.fieldNames) &&
      typeof event.loader === "string" &&
      typeof event.path === "string" &&
      ["fulfilled", "rejected"].includes(event.status)
    );
  }
  if (event.type === "payload.serialized") {
    return (
      Number.isSafeInteger(event.bytes) &&
      ["route-data", "rsc"].includes(event.kind) &&
      typeof event.path === "string"
    );
  }
  if (event.type === "request.finished") {
    return (
      Number.isFinite(event.durationMs) &&
      typeof event.path === "string" &&
      Number.isSafeInteger(event.status)
    );
  }
  return (
    event.type === "request.started" &&
    typeof event.method === "string" &&
    typeof event.path === "string"
  );
}

function isSnapshot(snapshot) {
  return (
    isObject(snapshot) &&
    snapshot.version === PROTOCOL_VERSION &&
    Number.isSafeInteger(snapshot.lastEventId) &&
    isObject(snapshot.instance) &&
    typeof snapshot.instance.id === "string" &&
    typeof snapshot.instance.prefix === "string" &&
    isObject(snapshot.sync) &&
    typeof snapshot.sync.enabled === "boolean" &&
    (snapshot.sync.streamPath === null || typeof snapshot.sync.streamPath === "string") &&
    Array.isArray(snapshot.events) &&
    snapshot.events.every(isServerEvent) &&
    Array.isArray(snapshot.routes) &&
    snapshot.routes.every(
      (route) =>
        isObject(route) &&
        typeof route.file === "string" &&
        typeof route.hasLoader === "boolean" &&
        typeof route.hasRequestLoader === "boolean" &&
        ["isr", "ssg", "ssr"].includes(route.mode) &&
        typeof route.pattern === "string" &&
        isStringArray(route.tags)
    ) &&
    Array.isArray(snapshot.caches) &&
    snapshot.caches.every(
      (entry) =>
        isObject(entry) &&
        Number.isFinite(entry.ageMs) &&
        isStringArray(entry.dependencies) &&
        isStringArray(entry.fieldNames) &&
        typeof entry.id === "string" &&
        typeof entry.isFresh === "boolean" &&
        ["isr", "ssg"].includes(entry.mode) &&
        typeof entry.path === "string" &&
        (entry.revalidateSeconds === null || Number.isFinite(entry.revalidateSeconds))
    )
  );
}

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in sandboxed development documents.
  }
}

function notifyBrowserState() {
  document.querySelector(ELEMENT_NAME)?.browserStateChanged();
}

function operationId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function requestUrl(input) {
  if (input instanceof Request) {
    return new URL(input.url, window.location.href);
  }
  return new URL(String(input), window.location.href);
}

function installFetchObserver() {
  const dataUrl = new URL(assetUrl("/_furin/data"), window.location.href);
  const observedFetch = async (input, init) => {
    const url = requestUrl(input);
    if (url.origin !== dataUrl.origin || url.pathname !== dataUrl.pathname) {
      return nativeFetch.call(window, input, init);
    }
    const id = operationId();
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    headers.set("x-furin-devtools-operation-id", id);
    const startedAt = performance.now();
    const logicalPath = url.searchParams.get("path") ?? url.pathname;
    pushBounded(browserState.operations, {
      durationMs: null,
      id,
      path: logicalPath,
      status: null,
      timestamp: Date.now(),
      type: "navigation.started",
    });
    notifyBrowserState();
    try {
      const response = await nativeFetch.call(window, input, { ...init, headers });
      pushBounded(browserState.operations, {
        durationMs: performance.now() - startedAt,
        id,
        path: logicalPath,
        status: response.status,
        timestamp: Date.now(),
        type: "navigation.finished",
      });
      notifyBrowserState();
      return response;
    } catch (error) {
      pushBounded(browserState.operations, {
        durationMs: performance.now() - startedAt,
        id,
        path: logicalPath,
        status: 0,
        timestamp: Date.now(),
        type: "navigation.failed",
      });
      notifyBrowserState();
      throw error;
    }
  };
  window.fetch = observedFetch;
  return () => {
    if (window.fetch === observedFetch) {
      window.fetch = nativeFetch;
    }
  };
}

function installSyncObserver(sync) {
  if (!(sync.enabled && sync.streamPath && typeof NativeEventSource === "function")) {
    return () => undefined;
  }
  const syncUrl = new URL(assetUrl(sync.streamPath), window.location.href);
  class ObservedEventSource extends NativeEventSource {
    constructor(url, options) {
      super(url, options);
      const absolute = new URL(String(url), window.location.href);
      if (absolute.origin !== syncUrl.origin || absolute.pathname !== syncUrl.pathname) {
        return;
      }
      browserState.syncStatus = "connecting";
      pushBounded(browserState.syncEvents, {
        cursor: null,
        timestamp: Date.now(),
        type: "connecting",
        url: absolute.pathname,
      });
      this.addEventListener("open", () => {
        browserState.syncStatus = "connected";
        pushBounded(browserState.syncEvents, {
          cursor: null,
          timestamp: Date.now(),
          type: "connected",
          url: absolute.pathname,
        });
        notifyBrowserState();
      });
      this.addEventListener("error", () => {
        browserState.syncStatus = "reconnecting";
        pushBounded(browserState.syncEvents, {
          cursor: null,
          timestamp: Date.now(),
          type: "reconnecting",
          url: absolute.pathname,
        });
        notifyBrowserState();
      });
      this.addEventListener("furin.sync", (event) => {
        let cursor = null;
        try {
          const payload = JSON.parse(event.data);
          cursor = typeof payload.cursor === "string" ? payload.cursor : null;
        } catch {
          cursor = null;
        }
        pushBounded(browserState.syncEvents, {
          cursor,
          timestamp: Date.now(),
          type: "cursor",
          url: absolute.pathname,
        });
        notifyBrowserState();
      });
      notifyBrowserState();
    }
  }
  window.EventSource = ObservedEventSource;
  return () => {
    if (window.EventSource === ObservedEventSource) {
      window.EventSource = NativeEventSource;
    }
  };
}

function refreshBundleEntries() {
  browserState.bundleEntries = [];
  for (const entry of performance.getEntriesByType("resource")) {
    const url = new URL(entry.name, window.location.href);
    if (url.origin !== window.location.origin || url.pathname.includes("/_furin/devtools/")) {
      continue;
    }
    browserState.bundleEntries.push({
      decodedBytes: entry.decodedBodySize,
      durationMs: entry.duration,
      encodedBytes: entry.encodedBodySize,
      name: url.pathname,
      transferredBytes: entry.transferSize,
      type: entry.initiatorType || "resource",
    });
  }
  browserState.bundleEntries.sort((left, right) => right.transferredBytes - left.transferredBytes);
}

function installResourceObserver() {
  refreshBundleEntries();
  if (typeof PerformanceObserver !== "function") {
    return () => undefined;
  }
  const observer = new PerformanceObserver(() => {
    refreshBundleEntries();
    notifyBrowserState();
  });
  observer.observe({ entryTypes: ["resource"] });
  return () => observer.disconnect();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  if (value < 1024) {
    return `${Math.round(value)} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDuration(value) {
  if (!Number.isFinite(value)) {
    return "—";
  }
  return value < 1 ? `${value.toFixed(2)} ms` : `${value.toFixed(1)} ms`;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusDot(status) {
  return `<span class="status status-${escapeHtml(status)}"></span>`;
}

function emptyState(title, detail) {
  return `<div class="empty"><span>${escapeHtml(title)}</span><small>${escapeHtml(detail)}</small></div>`;
}

function table(headers, rows) {
  if (rows.length === 0) {
    return emptyState("No data yet", "Interact with the application to populate this view.");
  }
  return `<div class="table-wrap"><table><thead><tr>${headers
    .map((header) => `<th>${escapeHtml(header)}</th>`)
    .join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function eventTitle(event) {
  if (event.type === "request.finished") {
    return `${event.status} ${event.path}`;
  }
  if (event.type === "loader.finished") {
    return `${event.loader} · ${event.path}`;
  }
  if (event.type === "cache.access") {
    return `${event.outcome.toUpperCase()} · ${event.path}`;
  }
  if (event.type === "cache.invalidated") {
    return `INVALIDATE · ${event.target}`;
  }
  if (event.type === "payload.serialized") {
    return `${event.kind === "rsc" ? "RSC" : "DATA"} · ${event.path}`;
  }
  return `${event.method ?? event.type} ${event.path ?? ""}`.trim();
}

function syncEventStatus(type) {
  if (type === "connected") {
    return "ok";
  }
  if (type === "reconnecting") {
    return "error";
  }
  return "live";
}

class FurinDevtoolsElement extends HTMLElement {
  /** @type {string} */
  #activeTab = "overview";
  /** @type {Array<object>} */
  #events = [];
  #root = this.attachShadow({ mode: "open" });
  /** @type {object | null} */
  #snapshot = null;

  connectedCallback() {
    this.render();
  }

  setSnapshot(snapshot) {
    this.#snapshot = snapshot;
    this.#events = [...snapshot.events];
    const storageKey = `furin:devtools:${snapshot.instance.id}:hidden`;
    this.toggleAttribute("data-hidden", readStorage(storageKey) === "true");
    browserState.syncStatus = snapshot.sync.enabled ? "waiting" : "disabled";
    this.render();
  }

  appendEvent(event) {
    if (this.#events.some((candidate) => candidate.id === event.id)) {
      return;
    }
    this.#events.push(event);
    if (this.#events.length > 1000) {
      this.#events.shift();
    }
    this.render();
  }

  browserStateChanged() {
    if (this.hasAttribute("data-open") && !this.hasAttribute("data-hidden")) {
      this.render();
    }
  }

  toggleHidden() {
    const hidden = !this.hasAttribute("data-hidden");
    this.toggleAttribute("data-hidden", hidden);
    this.removeAttribute("data-open");
    if (this.#snapshot !== null) {
      const storageKey = `furin:devtools:${this.#snapshot.instance.id}:hidden`;
      writeStorage(storageKey, String(hidden));
    }
    this.render();
  }

  closePanel() {
    if (this.hasAttribute("data-open")) {
      this.removeAttribute("data-open");
      this.render();
    }
  }

  async refreshSnapshot() {
    const response = await nativeFetch.call(window, assetUrl("/_furin/devtools/snapshot"));
    if (!response.ok) {
      return;
    }
    const snapshot = await response.json();
    if (isSnapshot(snapshot)) {
      this.setSnapshot(snapshot);
    }
  }

  render() {
    if (this.hasAttribute("data-hidden") || this.#snapshot === null) {
      this.#root.innerHTML = "<style>:host{display:none}</style>";
      return;
    }
    const open = this.hasAttribute("data-open");
    const panel = this.#root.querySelector(".panel");
    if (open && panel !== null) {
      for (const button of panel.querySelectorAll("[data-tab]")) {
        button.classList.toggle("active", button.dataset.tab === this.#activeTab);
      }
      const main = panel.querySelector("main");
      if (main !== null) {
        main.innerHTML = this.renderTab();
      }
      const eventCount = panel.querySelector("footer span");
      if (eventCount !== null) {
        eventCount.innerHTML = `${statusDot("live")} Live · ${this.#events.length} events`;
      }
      return;
    }
    const tabs = [
      ["overview", "Overview"],
      ["routes", "Routes"],
      ["loaders", "Loaders"],
      ["cache", "Cache"],
      ["sync", "Sync"],
      ["bundle", "Bundle"],
      ["rsc", "RSC"],
    ];
    const content = open ? this.renderTab() : "";
    this.#root.innerHTML = `
      <style>${this.styles()}</style>
      ${
        open
          ? `<section class="panel" role="dialog" aria-label="Furin DevTools">
              <header>
                <div class="brand"><span class="mark">F</span><span>Furin DevTools</span><small>DEV</small></div>
                <div class="header-actions">
                  <button class="text-button" data-action="hide" title="Hide until restored with the shortcut">Hide UI</button>
                  <button class="icon-button" data-action="close" aria-label="Close DevTools">×</button>
                </div>
              </header>
              <nav aria-label="DevTools panels">${tabs
                .map(
                  ([id, label]) =>
                    `<button class="${this.#activeTab === id ? "active" : ""}" data-tab="${id}">${label}</button>`
                )
                .join("")}</nav>
              <main>${content}</main>
              <footer><span>${statusDot("live")} Live · ${this.#events.length} events</span><kbd>⌘/Ctrl ⇧ .</kbd><span>hide / restore</span></footer>
            </section>`
          : ""
      }
      <button class="launcher ${open ? "launcher-open" : ""}" data-action="toggle" aria-label="${
        open ? "Close" : "Open"
      } Furin DevTools">
        <span class="launcher-mark">F</span>
        <span class="launcher-copy">DevTools</span>
        ${statusDot("live")}
      </button>`;
    this.#root.querySelector('[data-action="toggle"]')?.addEventListener("click", () => {
      this.toggleAttribute("data-open");
      this.render();
    });
    this.#root.querySelector('[data-action="close"]')?.addEventListener("click", () => {
      this.closePanel();
    });
    this.#root.querySelector('[data-action="hide"]')?.addEventListener("click", () => {
      this.toggleHidden();
    });
    for (const button of this.#root.querySelectorAll("[data-tab]")) {
      button.addEventListener("click", () => {
        this.#activeTab = button.dataset.tab;
        this.render();
        if (this.#activeTab === "cache") {
          this.refreshSnapshot().catch(() => undefined);
        }
      });
    }
  }

  renderTab() {
    if (this.#activeTab === "routes") {
      return this.renderRoutes();
    }
    if (this.#activeTab === "loaders") {
      return this.renderLoaders();
    }
    if (this.#activeTab === "cache") {
      return this.renderCache();
    }
    if (this.#activeTab === "sync") {
      return this.renderSync();
    }
    if (this.#activeTab === "bundle") {
      return this.renderBundle();
    }
    if (this.#activeTab === "rsc") {
      return this.renderPayloads();
    }
    return this.renderOverview();
  }

  renderOverview() {
    const finished = this.#events.filter((event) => event.type === "request.finished");
    const loaders = this.#events.filter((event) => event.type === "loader.finished");
    const cacheAccesses = this.#events.filter((event) => event.type === "cache.access");
    const hits = cacheAccesses.filter((event) => event.outcome === "hit").length;
    const payloadBytes = this.#events
      .filter((event) => event.type === "payload.serialized")
      .reduce((sum, event) => sum + event.bytes, 0);
    const transferred = browserState.bundleEntries.reduce(
      (sum, entry) => sum + entry.transferredBytes,
      0
    );
    const averageRequest =
      finished.length === 0
        ? Number.NaN
        : finished.reduce((sum, event) => sum + event.durationMs, 0) / finished.length;
    const activity = this.#events
      .filter((event) => event.type !== "request.started")
      .slice(-10)
      .reverse()
      .map(
        (event) => `<li>
          <span class="event-icon">${event.type === "cache.invalidated" ? "!" : "›"}</span>
          <div><strong>${escapeHtml(eventTitle(event))}</strong><small>${escapeHtml(
            event.type
          )}</small></div>
          <time>${formatTime(event.timestamp)}</time>
        </li>`
      )
      .join("");
    return `
      <div class="page-head"><div><h1>Runtime overview</h1><p>Live signals for this Furin instance.</p></div><span class="instance">#${escapeHtml(
        this.#snapshot.instance.id.slice(0, 8)
      )}</span></div>
      <div class="metrics">
        <article><span>Routes</span><strong>${this.#snapshot.routes.length}</strong><small>${this.#snapshot.routes.filter((route) => route.hasLoader).length} with loaders</small></article>
        <article><span>Avg request</span><strong>${formatDuration(averageRequest)}</strong><small>${finished.length} completed</small></article>
        <article><span>Cache hit rate</span><strong>${
          cacheAccesses.length === 0 ? "—" : `${Math.round((hits / cacheAccesses.length) * 100)}%`
        }</strong><small>${cacheAccesses.length} accesses</small></article>
        <article><span>Transferred</span><strong>${formatBytes(transferred)}</strong><small>${formatBytes(
          payloadBytes
        )} route payload</small></article>
      </div>
      <section class="block"><div class="block-title"><h2>Recent activity</h2><span>${
        loaders.length
      } loader runs</span></div>${
        activity
          ? `<ul class="activity">${activity}</ul>`
          : emptyState(
              "Waiting for activity",
              "Navigate through the application to collect runtime events."
            )
      }</section>`;
  }

  renderRoutes() {
    const rows = this.#snapshot.routes.map(
      (route) => `<tr>
        <td><code>${escapeHtml(route.pattern)}</code><small>${escapeHtml(route.file)}</small></td>
        <td><span class="mode mode-${escapeHtml(route.mode)}">${escapeHtml(route.mode.toUpperCase())}</span></td>
        <td>${route.hasLoader ? "loader" : "—"}${route.hasRequestLoader ? " + request" : ""}</td>
        <td>${route.tags.length ? route.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("") : "—"}</td>
      </tr>`
    );
    return `<div class="page-head"><div><h1>Routes</h1><p>Discovered files and rendering modes.</p></div><span class="count">${
      rows.length
    }</span></div>${table(["Pattern / file", "Mode", "Data", "Tags"], rows)}`;
  }

  renderLoaders() {
    const events = this.#events
      .filter((event) => event.type === "loader.finished")
      .slice()
      .reverse();
    const rows = events.map(
      (event) => `<tr>
        <td><code>${escapeHtml(event.loader)}</code><small>${escapeHtml(event.path)}</small></td>
        <td>${statusDot(event.status === "fulfilled" ? "ok" : "error")}${escapeHtml(event.status)}</td>
        <td>${formatDuration(event.durationMs)}</td>
        <td>${event.fieldNames.length ? event.fieldNames.map((field) => `<span class="tag">${escapeHtml(field)}</span>`).join("") : "—"}</td>
        <td><time>${formatTime(event.timestamp)}</time></td>
      </tr>`
    );
    return `<div class="page-head"><div><h1>Loaders</h1><p>Timings and field names. Values never leave the server.</p></div><span class="count">${
      rows.length
    }</span></div>${table(["Loader / path", "Status", "Duration", "Fields", "Time"], rows)}`;
  }

  renderCache() {
    const accesses = this.#events
      .filter((event) => event.type === "cache.access")
      .slice()
      .reverse();
    const invalidations = this.#events
      .filter((event) => event.type === "cache.invalidated")
      .slice()
      .reverse();
    const entries = this.#snapshot.caches.map(
      (entry) => `<tr>
        <td><code>${escapeHtml(entry.path)}</code><small>${escapeHtml(entry.id)}</small></td>
        <td><span class="mode mode-${escapeHtml(entry.mode)}">${escapeHtml(entry.mode.toUpperCase())}</span></td>
        <td>${statusDot(entry.isFresh ? "ok" : "stale")}${entry.isFresh ? "fresh" : "stale"}</td>
        <td>${formatDuration(entry.ageMs)}</td>
        <td>${entry.fieldNames.map((field) => `<span class="tag">${escapeHtml(field)}</span>`).join("") || "—"}</td>
      </tr>`
    );
    const accessRows = accesses.map(
      (event) =>
        `<tr><td><code>${escapeHtml(event.path)}</code></td><td><span class="outcome outcome-${escapeHtml(event.outcome)}">${escapeHtml(event.outcome.toUpperCase())}</span></td><td>${escapeHtml(event.cache)}</td><td><time>${formatTime(event.timestamp)}</time></td></tr>`
    );
    const invalidationRows = invalidations.map(
      (event) =>
        `<tr><td><code>${escapeHtml(event.target)}</code></td><td>${escapeHtml(event.reason)}</td><td>${event.deleted ? `${event.purgedPaths} purged` : "no match"}</td><td><time>${formatTime(event.timestamp)}</time></td></tr>`
    );
    return `<div class="page-head"><div><h1>Cache</h1><p>Current loader entries, access decisions and invalidations.</p></div><span class="count">${
      entries.length
    }</span></div>
      <section class="block"><div class="block-title"><h2>Entries</h2></div>${table(
        ["Path", "Mode", "State", "Age", "Fields"],
        entries
      )}</section>
      <section class="split"><div class="block"><div class="block-title"><h2>Accesses</h2></div>${table(
        ["Path", "Result", "Cache", "Time"],
        accessRows
      )}</div><div class="block"><div class="block-title"><h2>Invalidations</h2></div>${table(
        ["Target", "Reason", "Result", "Time"],
        invalidationRows
      )}</div></section>`;
  }

  renderSync() {
    const { enabled } = this.#snapshot.sync;
    const events = browserState.syncEvents.slice().reverse();
    const rows = events.map(
      (event) =>
        `<tr><td>${statusDot(syncEventStatus(event.type))}${escapeHtml(event.type)}</td><td><code>${escapeHtml(event.cursor ?? "—")}</code></td><td>${escapeHtml(event.url)}</td><td><time>${formatTime(event.timestamp)}</time></td></tr>`
    );
    return `<div class="page-head"><div><h1>Sync stream</h1><p>The application’s native EventSource connection and cursors.</p></div><span class="connection">${statusDot(
      enabled ? browserState.syncStatus : "disabled"
    )}${escapeHtml(enabled ? browserState.syncStatus : "disabled")}</span></div>
      <section class="block sync-summary"><dl><div><dt>Configured</dt><dd>${
        enabled ? "yes" : "no"
      }</dd></div><div><dt>Stream</dt><dd><code>${escapeHtml(
        this.#snapshot.sync.streamPath ?? "—"
      )}</code></dd></div><div><dt>Events</dt><dd>${events.length}</dd></div></dl></section>
      ${table(["State", "Cursor", "Stream", "Time"], rows)}`;
  }

  renderBundle() {
    refreshBundleEntries();
    const total = browserState.bundleEntries.reduce(
      (sum, entry) => sum + entry.transferredBytes,
      0
    );
    const decoded = browserState.bundleEntries.reduce((sum, entry) => sum + entry.decodedBytes, 0);
    const rows = browserState.bundleEntries.map(
      (entry) =>
        `<tr><td><code>${escapeHtml(entry.name)}</code><small>${escapeHtml(
          entry.type
        )}</small></td><td>${formatBytes(entry.transferredBytes)}</td><td>${formatBytes(
          entry.encodedBytes
        )}</td><td>${formatBytes(entry.decodedBytes)}</td><td>${formatDuration(
          entry.durationMs
        )}</td></tr>`
    );
    return `<div class="page-head"><div><h1>Bundle transfer</h1><p>Actual browser Resource Timing values, excluding DevTools.</p></div><span class="count">${formatBytes(
      total
    )}</span></div>
      <div class="metrics compact"><article><span>Transferred</span><strong>${formatBytes(
        total
      )}</strong><small>network bytes</small></article><article><span>Decoded</span><strong>${formatBytes(
        decoded
      )}</strong><small>runtime bytes</small></article><article><span>Resources</span><strong>${
        rows.length
      }</strong><small>same origin</small></article></div>
      ${table(["Resource", "Transfer", "Encoded", "Decoded", "Duration"], rows)}`;
  }

  renderPayloads() {
    const events = this.#events
      .filter((event) => event.type === "payload.serialized")
      .slice()
      .reverse();
    const total = events.reduce((sum, event) => sum + event.bytes, 0);
    const rows = events.map(
      (event) =>
        `<tr><td><code>${escapeHtml(event.path)}</code></td><td><span class="mode ${
          event.kind === "rsc" ? "mode-rsc" : "mode-data"
        }">${event.kind === "rsc" ? "RSC" : "ROUTE DATA"}</span></td><td>${formatBytes(
          event.bytes
        )}</td><td><code>${escapeHtml(event.operationId ?? "server")}</code></td><td><time>${formatTime(
          event.timestamp
        )}</time></td></tr>`
    );
    return `<div class="page-head"><div><h1>RSC & route payloads</h1><p>Serialized wire size only; payload values are never retained.</p></div><span class="count">${formatBytes(
      total
    )}</span></div>${table(["Path", "Kind", "Wire size", "Operation", "Time"], rows)}`;
  }

  styles() {
    return `
      :host{all:initial;position:fixed;z-index:2147483647;left:16px;bottom:16px;color:#f3f2ec;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:dark}
      *{box-sizing:border-box}button{font:inherit}.launcher{height:38px;display:flex;align-items:center;gap:8px;padding:0 12px 0 7px;border:1px solid #383834;border-radius:999px;background:#151514;color:#f3f2ec;box-shadow:0 10px 36px #0007;cursor:pointer;transition:transform .16s ease,border-color .16s ease}.launcher:hover{transform:translateY(-1px);border-color:#5c5b53}.launcher-open{border-color:#d3ff57}.launcher-mark,.mark{display:grid;place-items:center;background:#d3ff57;color:#11120d;font-weight:900}.launcher-mark{width:24px;height:24px;border-radius:50%;font-size:12px}.launcher-copy{font-size:12px;font-weight:650;letter-spacing:.01em}
      .panel{position:absolute;left:0;bottom:48px;width:min(900px,calc(100vw - 32px));height:min(590px,calc(100vh - 96px));display:grid;grid-template-rows:50px 40px 1fr 30px;overflow:hidden;border:1px solid #383834;border-radius:12px;background:#11110f;box-shadow:0 28px 90px #000a,0 0 0 1px #000;animation:enter .16s ease-out}@keyframes enter{from{opacity:0;transform:translateY(8px) scale(.992)}}
      header{display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-bottom:1px solid #2b2b27;background:#171715}.brand{display:flex;align-items:center;gap:9px;font-size:13px;font-weight:700}.brand .mark{width:23px;height:23px;border-radius:5px;font-size:12px}.brand small{padding:2px 5px;border:1px solid #44443d;border-radius:4px;color:#aaa99e;font:700 9px ui-monospace,monospace;letter-spacing:.08em}.header-actions{display:flex;align-items:center;gap:5px}.text-button,.icon-button{border:0;background:transparent;color:#aaa99e;cursor:pointer}.text-button{padding:6px 8px;font-size:11px}.text-button:hover,.icon-button:hover{color:#fff}.icon-button{width:28px;height:28px;font-size:20px}
      nav{display:flex;align-items:end;gap:2px;padding:0 11px;border-bottom:1px solid #2b2b27;background:#141412;overflow-x:auto}nav button{height:39px;padding:0 10px;border:0;border-bottom:2px solid transparent;background:transparent;color:#8f8e84;font-size:11px;cursor:pointer;white-space:nowrap}nav button:hover{color:#d8d7ce}nav button.active{border-color:#d3ff57;color:#f5f4ee}
      main{min-height:0;overflow:auto;padding:18px;background:radial-gradient(circle at 85% -20%,#272820 0,transparent 36%),#11110f;scrollbar-color:#3c3c36 transparent;scrollbar-width:thin}footer{display:flex;align-items:center;gap:6px;padding:0 12px;border-top:1px solid #2b2b27;background:#151513;color:#77776f;font-size:9px}footer span:first-child{margin-right:auto;display:flex;align-items:center;gap:5px}kbd{padding:1px 4px;border:1px solid #3b3b36;border-radius:3px;background:#1e1e1b;color:#aaa99f;font:9px ui-monospace,monospace}
      .page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}.page-head h1{margin:0 0 4px;color:#f4f3ed;font-size:18px;line-height:1.2;letter-spacing:-.02em}.page-head p{margin:0;color:#85857c;font-size:11px}.count,.instance,.connection{display:flex;align-items:center;gap:6px;padding:5px 8px;border:1px solid #363631;border-radius:5px;background:#181816;color:#b9b8ae;font:10px ui-monospace,monospace}
      .metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:16px}.metrics.compact{grid-template-columns:repeat(3,minmax(0,1fr))}.metrics article{min-width:0;padding:13px;border:1px solid #30302b;border-radius:8px;background:linear-gradient(145deg,#1b1b18,#161614)}.metrics article span{display:block;color:#88877e;font-size:10px}.metrics article strong{display:block;overflow:hidden;margin:7px 0 3px;color:#f4f3ed;font:700 20px ui-monospace,monospace;letter-spacing:-.04em;text-overflow:ellipsis}.metrics article small{color:#66665f;font-size:9px}
      .block{margin-bottom:12px;border:1px solid #2d2d29;border-radius:8px;background:#151513;overflow:hidden}.block-title{height:36px;display:flex;align-items:center;justify-content:space-between;padding:0 11px;border-bottom:1px solid #2b2b27}.block-title h2{margin:0;color:#cac9bf;font-size:11px}.block-title span{color:#6f6f68;font-size:9px}.split{display:grid;grid-template-columns:1fr 1fr;gap:10px}.sync-summary{padding:12px}.sync-summary dl{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:0}.sync-summary dl div{padding:9px;border:1px solid #2f2f2a;border-radius:6px;background:#191917}.sync-summary dt{color:#77776f;font-size:9px}.sync-summary dd{margin:5px 0 0;color:#d9d8cf;font-size:11px}
      .table-wrap{overflow:auto;border:1px solid #2d2d29;border-radius:8px;background:#151513}.block>.table-wrap{border:0;border-radius:0}table{width:100%;border-collapse:collapse;table-layout:auto}th{position:sticky;top:0;z-index:1;padding:8px 10px;border-bottom:1px solid #31312c;background:#1a1a18;color:#77776e;font-size:9px;font-weight:600;text-align:left;text-transform:uppercase;letter-spacing:.06em}td{max-width:300px;padding:9px 10px;border-bottom:1px solid #292925;color:#b9b8ae;font-size:10px;vertical-align:middle}tr:last-child td{border-bottom:0}tr:hover td{background:#1a1a17}td small{display:block;overflow:hidden;margin-top:3px;color:#66665f;font-size:8px;text-overflow:ellipsis;white-space:nowrap}code{color:#d7d6cc;font:9px ui-monospace,SFMono-Regular,Consolas,monospace}
      .activity{margin:0;padding:0;list-style:none}.activity li{display:grid;grid-template-columns:24px 1fr auto;align-items:center;gap:8px;padding:8px 11px;border-bottom:1px solid #292925}.activity li:last-child{border:0}.event-icon{display:grid;place-items:center;width:21px;height:21px;border:1px solid #34342f;border-radius:5px;background:#1d1d1a;color:#d3ff57;font:700 12px ui-monospace,monospace}.activity strong{display:block;color:#cac9c0;font-size:10px;font-weight:600}.activity small{color:#686861;font-size:8px}.activity time,time{color:#66665f;font:8px ui-monospace,monospace}
      .empty{display:grid;place-items:center;min-height:120px;padding:25px;color:#85857c;text-align:center}.empty span{font-size:11px}.empty small{margin-top:5px;color:#5f5f59;font-size:9px}.status{display:inline-block;width:6px;height:6px;margin-right:5px;border-radius:50%;background:#666}.status-live,.status-connected,.status-ok{background:#8bea69;box-shadow:0 0 0 3px #8bea6915}.status-waiting,.status-connecting,.status-stale{background:#f5c45c}.status-reconnecting,.status-error{background:#ff715f}.status-disabled{background:#5e5e58}
      .mode,.outcome,.tag{display:inline-flex;align-items:center;margin:1px 3px 1px 0;border-radius:4px;font:700 8px ui-monospace,monospace}.mode,.outcome{padding:3px 5px;border:1px solid #3a3a34}.mode-ssr{color:#75d8ff}.mode-ssg{color:#c4a5ff}.mode-isr{color:#f4ca67}.mode-rsc{color:#d3ff57}.mode-data{color:#80cfff}.outcome-hit{color:#8bea69}.outcome-miss{color:#f4ca67}.outcome-stale{color:#ff8a78}.tag{padding:2px 4px;background:#282824;color:#aaa99f;font-weight:500}
      @media(max-width:720px){:host{left:8px;bottom:8px}.panel{bottom:46px;width:calc(100vw - 16px);height:calc(100vh - 70px)}main{padding:12px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.split{grid-template-columns:1fr}.launcher-copy{display:none}}
      @media(prefers-reduced-motion:reduce){.panel,.launcher{animation:none;transition:none}}
    `;
  }
}

function isEditableTarget(target) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

function installKeyboardShortcut() {
  const listener = (event) => {
    if (event.key === "Escape") {
      document.querySelector(ELEMENT_NAME)?.closePanel();
      return;
    }
    if (
      (event.code === "Period" || event.key === ".") &&
      event.shiftKey &&
      (event.metaKey || event.ctrlKey) &&
      !isEditableTarget(event.target)
    ) {
      event.preventDefault();
      document.querySelector(ELEMENT_NAME)?.toggleHidden();
    }
  };
  window.addEventListener("keydown", listener);
  return () => window.removeEventListener("keydown", listener);
}

async function start() {
  const response = await nativeFetch.call(window, assetUrl("/_furin/devtools/snapshot"));
  if (!response.ok) {
    return;
  }
  const snapshot = await response.json();
  if (!isSnapshot(snapshot)) {
    return;
  }
  runtime.cleanup?.();
  const cleanups = [];
  const cleanup = () => {
    for (const dispose of cleanups.reverse()) {
      dispose();
    }
    runtime.cleanup = null;
  };
  try {
    cleanups.push(installFetchObserver());
    cleanups.push(installSyncObserver(snapshot.sync));
    cleanups.push(installResourceObserver());
    if (!customElements.get(ELEMENT_NAME)) {
      customElements.define(ELEMENT_NAME, FurinDevtoolsElement);
    }
    const element = document.querySelector(ELEMENT_NAME) ?? document.createElement(ELEMENT_NAME);
    if (!element.isConnected) {
      document.body.append(element);
      cleanups.push(() => element.remove());
    }
    element.setSnapshot(snapshot);
    cleanups.push(installKeyboardShortcut());
    const source = new NativeEventSource(
      `${assetUrl("/_furin/devtools/events")}?after=${snapshot.lastEventId}`
    );
    cleanups.push(() => source.close());
    source.addEventListener(DEVTOOLS_EVENT, (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (isServerEvent(payload) && payload.instanceId === snapshot.instance.id) {
          element.appendEvent(payload);
        }
      } catch {
        // A malformed development event must never affect the application.
      }
    });
    runtime.cleanup = cleanup;
  } catch (error) {
    cleanup();
    throw error;
  }
}

start().catch(() => undefined);
