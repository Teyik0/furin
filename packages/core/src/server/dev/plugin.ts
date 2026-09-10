import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type AnyElysia, Elysia } from "elysia";
import type { DevGraph, DevGraphEvent } from "./graph.ts";

type DevErrorEvent = Extract<DevGraphEvent, { type: "error" }>;

let overlayClientSource: string | undefined;

function clientSource(): string {
  const sourcePath = [
    resolve(import.meta.dir, "../../client/dev-error-overlay.js"),
    resolve(import.meta.dir, "../src/client/dev-error-overlay.js"),
  ].find((path) => existsSync(path));
  if (!sourcePath) {
    throw new Error("[furin] Development error overlay client is missing.");
  }
  overlayClientSource ??= readFileSync(sourcePath, "utf8");
  return overlayClientSource;
}

function eventCursor(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function serializeForHtml(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function renderDevErrorResponse(event: DevErrorEvent, basePath: string): Response {
  const clientPath = `${basePath}/_furin/dev/error-overlay.js`;
  const state = serializeForHtml({ basePath, event });
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Furin development error</title></head><body><script id="__FURIN_DEV_ERROR__" type="application/json">${state}</script><script type="module" src="${clientPath}"></script></body></html>`,
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
      status: 500,
    }
  );
}

export function createDevErrorPlugin<Snapshot>(graph: DevGraph<Snapshot>): AnyElysia {
  const subscriptions = new WeakMap<object, () => void>();
  return new Elysia({ name: "furin-dev-errors" })
    .get(
      "/_furin/dev/error-overlay.js",
      () =>
        new Response(clientSource(), {
          headers: {
            "cache-control": "no-store",
            "content-type": "text/javascript; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        })
    )
    .ws("/_furin/dev/errors", {
      close(ws) {
        subscriptions.get(ws.raw)?.();
        subscriptions.delete(ws.raw);
      },
      open(ws) {
        const cursor = eventCursor(ws.data.query.after);
        const subscription = graph.subscribe(cursor, (event) => {
          ws.send(JSON.stringify(event));
        });
        subscriptions.set(ws.raw, subscription.unsubscribe);
        for (const event of subscription.replay) {
          ws.send(JSON.stringify(event));
        }
      },
    });
}
