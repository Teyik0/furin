export const DEVTOOLS_PROTOCOL_VERSION = 2 as const;

export type DevtoolsRouteMode = "isr" | "ssg" | "ssr";

export interface DevtoolsRoute {
  file: string;
  hasLoader: boolean;
  hasRequestLoader: boolean;
  mode: DevtoolsRouteMode;
  pattern: string;
  tags: string[];
}

export interface DevtoolsCacheEntry {
  ageMs: number;
  dependencies: string[];
  fieldNames: string[];
  id: string;
  isFresh: boolean;
  mode: "isr" | "ssg";
  path: string;
  revalidateSeconds: number | null;
}

export interface DevtoolsInstance {
  id: string;
  prefix: string;
}

export interface DevtoolsSyncSnapshot {
  changesPath: string | null;
  enabled: boolean;
}

export type DevtoolsServerEvent =
  | {
      bytes: number;
      id: number;
      instanceId: string;
      kind: "route-data" | "rsc";
      operationId: string | null;
      path: string;
      requestId: string;
      timestamp: number;
      type: "payload.serialized";
      version: typeof DEVTOOLS_PROTOCOL_VERSION;
    }
  | {
      deleted: boolean;
      id: number;
      instanceId: string;
      operationId: string | null;
      purgedPaths: number;
      reason: "path" | "source" | "tag";
      requestId: string | null;
      target: string;
      timestamp: number;
      type: "cache.invalidated";
      version: typeof DEVTOOLS_PROTOCOL_VERSION;
    }
  | {
      cache: "isr-loader" | "ssg-loader";
      id: number;
      instanceId: string;
      operationId: string | null;
      outcome: "hit" | "miss" | "stale";
      path: string;
      requestId: string;
      timestamp: number;
      type: "cache.access";
      version: typeof DEVTOOLS_PROTOCOL_VERSION;
    }
  | {
      durationMs: number;
      fieldNames: string[];
      id: number;
      instanceId: string;
      loader: string;
      operationId: string | null;
      path: string;
      requestId: string;
      status: "fulfilled" | "rejected";
      timestamp: number;
      type: "loader.finished";
      version: typeof DEVTOOLS_PROTOCOL_VERSION;
    }
  | {
      durationMs: number;
      id: number;
      instanceId: string;
      operationId: string | null;
      path: string;
      requestId: string;
      status: number;
      timestamp: number;
      type: "request.finished";
      version: typeof DEVTOOLS_PROTOCOL_VERSION;
    }
  | {
      id: number;
      instanceId: string;
      method: string;
      operationId: string | null;
      path: string;
      requestId: string;
      timestamp: number;
      type: "request.started";
      version: typeof DEVTOOLS_PROTOCOL_VERSION;
    };

export type DevtoolsServerEventInput =
  | Omit<
      Extract<DevtoolsServerEvent, { type: "payload.serialized" }>,
      "id" | "instanceId" | "version"
    >
  | Omit<
      Extract<DevtoolsServerEvent, { type: "cache.invalidated" }>,
      "id" | "instanceId" | "version"
    >
  | Omit<Extract<DevtoolsServerEvent, { type: "cache.access" }>, "id" | "instanceId" | "version">
  | Omit<Extract<DevtoolsServerEvent, { type: "loader.finished" }>, "id" | "instanceId" | "version">
  | Omit<
      Extract<DevtoolsServerEvent, { type: "request.finished" }>,
      "id" | "instanceId" | "version"
    >
  | Omit<
      Extract<DevtoolsServerEvent, { type: "request.started" }>,
      "id" | "instanceId" | "version"
    >;

export interface DevtoolsSnapshot {
  caches: DevtoolsCacheEntry[];
  events: DevtoolsServerEvent[];
  instance: DevtoolsInstance;
  lastEventId: number;
  routes: DevtoolsRoute[];
  sync: DevtoolsSyncSnapshot;
  version: typeof DEVTOOLS_PROTOCOL_VERSION;
}
