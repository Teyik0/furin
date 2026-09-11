import type { AnyElysia } from "elysia";
import type { DevtoolsServerEventInput } from "../../devtools/protocol.ts";
import type { ResolvedRoutesSource } from "../router/types.ts";
import { appendDevtoolsEvent } from "./hub.ts";
import { createDevtoolsPlugin } from "./plugin.ts";
import {
  currentDevtoolsRequest,
  type DevtoolsRequestContext,
  runWithDevtoolsRequest,
} from "./request-context.ts";

const CLIENT_PATH = "/_furin/devtools/client.js";

type EventInput<T extends DevtoolsServerEventInput["type"]> = Omit<
  Extract<DevtoolsServerEventInput, { type: T }>,
  "timestamp" | "type"
>;

export type CacheAccessInput = EventInput<"cache.access">;
export type CacheInvalidatedInput = EventInput<"cache.invalidated">;
export type LoaderFinishedInput = EventInput<"loader.finished">;
export type PayloadSerializedInput = EventInput<"payload.serialized">;

export function emitCacheAccess(event: CacheAccessInput): void {
  appendDevtoolsEvent({ ...event, timestamp: Date.now(), type: "cache.access" });
}

export function emitCacheInvalidated(event: CacheInvalidatedInput): void {
  appendDevtoolsEvent({ ...event, timestamp: Date.now(), type: "cache.invalidated" });
}

export function emitLoaderFinished(event: LoaderFinishedInput): void {
  appendDevtoolsEvent({ ...event, timestamp: Date.now(), type: "loader.finished" });
}

export function emitPayloadSerialized(event: PayloadSerializedInput): void {
  appendDevtoolsEvent({ ...event, timestamp: Date.now(), type: "payload.serialized" });
}

export function currentInstrumentationRequest(): DevtoolsRequestContext | undefined {
  return currentDevtoolsRequest();
}

export function runWithRequestInstrumentation<T>(request: Request, fn: () => T): T {
  return runWithDevtoolsRequest(request, fn);
}

export function shouldInstrumentRequest(pathname: string, prefix: string): boolean {
  const internalPaths = [
    `${prefix}/_furin/dev`,
    `${prefix}/_furin/devtools`,
    `${prefix}/_furin/events`,
  ];
  return internalPaths.every(
    (internalPath) => pathname !== internalPath && !pathname.startsWith(`${internalPath}/`)
  );
}

export function instrumentationLoggerExclusions(prefix: string): string[] {
  return [`${prefix}/_furin/dev/**`, `${prefix}/_furin/devtools/**`, `${prefix}/_furin/events/**`];
}

export function createInstrumentationPlugin(
  routes: ResolvedRoutesSource,
  syncPath: string | undefined
): AnyElysia {
  return createDevtoolsPlugin(routes, syncPath);
}

export function injectInstrumentationClient(html: string, prefix: string): string {
  const script = `<script data-furin-framework-module="" type="module" src="${prefix}${CLIENT_PATH}"></script>`;
  if (html.includes(script)) {
    return html;
  }
  return html.includes("</head>")
    ? html.replace("</head>", `${script}</head>`)
    : `${script}${html}`;
}
