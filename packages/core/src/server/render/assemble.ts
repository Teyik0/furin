// biome-ignore-all lint/performance/noAwaitInLoops: readable streams must be consumed sequentially
import type { toCrossJSON } from "seroval";
import { getSyncStreamPath } from "../sync/config.ts";
import { safeJson } from "./shell";

/**
 * Single source of truth for the global registry name used by the SSR
 * streaming script, the client hydration entry, and any test helper. Keeping
 * it centralised here avoids `<script>`/JS source drift if the name is ever
 * renamed.
 */
export const FURIN_DEFERRED_GLOBAL = "__FURIN_DEFERRED__";

// ── Deferred streaming helpers ─────────────────────────────────────────────────

/**
 * Generates the `window.__FURIN_DEFERRED__` registry script that is injected
 * BEFORE the React stream starts. It sets up the resolve/reject/getPromise API
 * for late chunks.
 *
 * Client-side `<Await>` components call `getPromise(key)` to obtain a Promise
 * they can pass to React 19's `use()`. The late resolution scripts call
 * `resolve(key, chunk)` / `reject(key, chunk)` to settle those Promises.
 *
 * Synchronous loader data is NOT carried here — it lives exclusively in the
 * `__FURIN_DATA__` JSON script that the hydrate entry reads.
 *
 * CSP note: this is an inline `<script>` — nonce support is a v2 concern.
 */
export function buildDeferredScript(deferredKeys: string[]): string {
  const keysJson = safeJson(deferredKeys);
  return `<script id="${FURIN_DEFERRED_GLOBAL}">
window.${FURIN_DEFERRED_GLOBAL} = {
  _deferredKeys: ${keysJson},
  _chunks: {},
  _resolvers: {},
  resolve(key, chunk) {
    this._chunks[key] = { a: 0, v: chunk };
  },
  reject(key, chunk) {
    this._chunks[key] = { a: 1, v: chunk };
  },
  getPromise(key) {
    if (!this._resolvers[key]) {
      var res, rej;
      var p = new Promise(function(resolve, reject) { res = resolve; rej = reject; });
      this._resolvers[key] = { resolve: res, reject: rej, promise: p };
    }
    return this._resolvers[key].promise;
  }
};
</script>`;
}

/**
 * Generates a late `<script>` that settles one deferred Promise on the client.
 * The `chunk` must be a seroval CrossJSON value produced by `toCrossJSON(value)`.
 *
 * @param key    - The Promise key (matches what `getPromise(key)` was called with)
 * @param chunk  - The already-serialised CrossJSON value
 * @param action - "resolve" or "reject"
 */
export function buildDeferredResolution(
  key: string,
  chunk: ReturnType<typeof toCrossJSON>,
  action: "resolve" | "reject"
): string {
  const chunkJson = safeJson(chunk);
  return `<script>window.${FURIN_DEFERRED_GLOBAL}.${action}(${safeJson(key)},${chunkJson})</script>`;
}

/** Minimal context passed to background / synthetic render helpers — only `request` is needed. */
export interface LoaderContext {
  request: Request;
}

export function resolvePath(pattern: string, params: Record<string, string>): string {
  let path = pattern;
  for (const [key, val] of Object.entries(params)) {
    path = path.replace(key === "*" ? "*" : `:${key}`, val);
  }
  return path;
}

export async function streamToString(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let html = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      html += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  html += decoder.decode();
  return html;
}

export function buildRouteFrameTemplate(payload: string): string {
  const escaped = payload.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return `<template id="__FURIN_ROUTE_FRAMES__">${escaped}</template>`;
}

export function buildRouteFrameStreamScript(): string {
  return `<script id="__FURIN_ROUTE_FRAME_STREAM__">
window.__FURIN_ROUTE_FRAME_STREAM__ = {
  _chunks: [],
  _closed: false,
  _controller: undefined,
  push(chunk) {
    if (this._controller) {
      this._controller.enqueue(new TextEncoder().encode(chunk));
    } else {
      this._chunks.push(chunk);
    }
  },
  close() {
    this._closed = true;
    if (this._controller) {
      this._controller.close();
    }
  },
  stream(initial) {
    var self = this;
    return new ReadableStream({
      start(controller) {
        self._controller = controller;
        if (initial) {
          controller.enqueue(new TextEncoder().encode(initial));
        }
        for (var i = 0; i < self._chunks.length; i++) {
          controller.enqueue(new TextEncoder().encode(self._chunks[i]));
        }
        self._chunks = [];
        if (self._closed) {
          controller.close();
        }
      }
    });
  }
};
</script>`;
}

export function buildRouteFramePushScript(payload: string): string {
  return `<script>window.__FURIN_ROUTE_FRAME_STREAM__.push(${safeJson(payload)})</script>`;
}

export function buildRouteFrameCloseScript(): string {
  return "<script>window.__FURIN_ROUTE_FRAME_STREAM__.close()</script>";
}

export function buildSyncRuntimeScript(): string {
  const syncStreamPath = getSyncStreamPath();
  if (!syncStreamPath) {
    return "";
  }

  return `<script id="__FURIN_SYNC__" type="application/json">${safeJson({ stream: syncStreamPath })}</script>`;
}

export function injectSyncRuntimeScript(html: string): string {
  if (html.includes('id="__FURIN_SYNC__"')) {
    return html;
  }

  const syncScript = buildSyncRuntimeScript();
  if (!syncScript) {
    return html;
  }

  return html.includes("</body>")
    ? html.replace("</body>", `${syncScript}</body>`)
    : html + syncScript;
}
