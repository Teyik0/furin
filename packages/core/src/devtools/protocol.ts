export const DEVTOOLS_PROTOCOL_VERSION = 2 as const;

export type DevtoolsRouteMode = "isr" | "ssg" | "ssr";
export type DevtoolsConnectionState = "connected" | "connecting" | "disconnected" | "reconnecting";
export type DevtoolsFullReloadReason =
  | "development-error-recovered"
  | "hmr-connection-recovered"
  | "hmr-runtime-unavailable"
  | "native-hmr-boundary-missing"
  | "unknown-native-hmr-reason";
export type DevtoolsHmrClientPhase = "after-update" | "before-update" | "paint";

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

export interface DevtoolsRuntimeSnapshot {
  graph: {
    edges: number;
    modules: number;
    revision: number;
  };
  memory: {
    heapBytes: number;
    rssBytes: number;
  };
}

export interface DevtoolsResource {
  decodedBytes: number;
  durationMs: number;
  encodedBytes: number;
  name: string;
  transferredBytes: number;
  type: string;
}

export interface DevtoolsError {
  cause: string | null;
  column: number | null;
  file: string | null;
  importChain: string[];
  line: number | null;
  message: string;
  phase: "hydrate" | "import" | "loader" | "render" | "transform";
  route: string;
  stack: string | null;
}

interface DevtoolsEventBase {
  id: number;
  instanceId: string;
  timestamp: number;
  version: typeof DEVTOOLS_PROTOCOL_VERSION;
}

interface DevtoolsBrowserEventBase {
  clientId: string;
  clientTimestamp: number;
}

export type DevtoolsServerEvent =
  | (DevtoolsEventBase & {
      bytes: number;
      kind: "route-data" | "rsc";
      operationId: string | null;
      path: string;
      requestId: string;
      type: "payload.serialized";
    })
  | (DevtoolsEventBase & {
      deleted: boolean;
      operationId: string | null;
      purgedPaths: number;
      reason: "path" | "source" | "tag";
      requestId: string | null;
      target: string;
      type: "cache.invalidated";
    })
  | (DevtoolsEventBase & {
      cache: "isr-loader" | "ssg-loader";
      operationId: string | null;
      outcome: "hit" | "miss" | "stale";
      path: string;
      requestId: string;
      type: "cache.access";
    })
  | (DevtoolsEventBase & {
      durationMs: number;
      fieldNames: string[];
      loader: string;
      operationId: string | null;
      path: string;
      requestId: string;
      status: "fulfilled" | "rejected";
      type: "loader.finished";
    })
  | (DevtoolsEventBase & {
      durationMs: number;
      operationId: string | null;
      path: string;
      requestId: string;
      status: number;
      type: "request.finished";
    })
  | (DevtoolsEventBase & {
      method: string;
      operationId: string | null;
      path: string;
      requestId: string;
      type: "request.started";
    })
  | (DevtoolsEventBase & {
      error: DevtoolsError;
      revision: number;
      type: "dev.error";
    })
  | (DevtoolsEventBase & {
      revision: number;
      type: "dev.ready";
    })
  | (DevtoolsEventBase & {
      changedModule: string;
      cycleId: string;
      detectedAt: number;
      type: "hmr.cycle.started";
    })
  | (DevtoolsEventBase & {
      changedModules: string[];
      cycleId: string;
      detectedAt: number;
      durationMs: number;
      rebuiltModules: string[];
      startedAt: number;
      status: "fulfilled" | "rejected";
      type: "hmr.build.finished";
    })
  | (DevtoolsEventBase & {
      changedModules: string[];
      cycleId: string;
      detectedAt: number;
      durationMs: number;
      rebuiltModules: string[];
      startedAt: number;
      status: "fulfilled" | "rejected";
      type: "hmr.server.finished";
    })
  | (DevtoolsBrowserEventBase &
      DevtoolsEventBase & {
        cycleId: string | null;
        durationMs: number | null;
        module: string | null;
        phase: DevtoolsHmrClientPhase;
        type: "hmr.client.phase";
      })
  | (DevtoolsBrowserEventBase &
      DevtoolsEventBase & {
        state: DevtoolsConnectionState;
        type: "hmr.connection.changed";
      })
  | (DevtoolsBrowserEventBase &
      DevtoolsEventBase & {
        cycleId: string | null;
        reason: DevtoolsFullReloadReason;
        type: "hmr.full-reload";
      })
  | (DevtoolsBrowserEventBase &
      DevtoolsEventBase & {
        resources: DevtoolsResource[];
        type: "browser.resources";
      })
  | (DevtoolsBrowserEventBase &
      DevtoolsEventBase & {
        cursor: string | null;
        state: DevtoolsConnectionState | "disabled";
        type: "sync.connection.changed";
      });

export type DevtoolsBrowserEventInput =
  | Omit<
      Extract<DevtoolsServerEvent, { type: "hmr.client.phase" }>,
      "id" | "instanceId" | "timestamp" | "version"
    >
  | Omit<
      Extract<DevtoolsServerEvent, { type: "hmr.connection.changed" }>,
      "id" | "instanceId" | "timestamp" | "version"
    >
  | Omit<
      Extract<DevtoolsServerEvent, { type: "hmr.full-reload" }>,
      "id" | "instanceId" | "timestamp" | "version"
    >
  | Omit<
      Extract<DevtoolsServerEvent, { type: "browser.resources" }>,
      "id" | "instanceId" | "timestamp" | "version"
    >
  | Omit<
      Extract<DevtoolsServerEvent, { type: "sync.connection.changed" }>,
      "id" | "instanceId" | "timestamp" | "version"
    >;

type WithoutBrowserMetadata<Event> = Event extends DevtoolsBrowserEventInput
  ? Omit<Event, "clientId" | "clientTimestamp">
  : never;

export type DevtoolsBrowserEventPayload = WithoutBrowserMetadata<DevtoolsBrowserEventInput>;

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
  | Omit<Extract<DevtoolsServerEvent, { type: "request.started" }>, "id" | "instanceId" | "version">
  | Omit<Extract<DevtoolsServerEvent, { type: "dev.error" }>, "id" | "instanceId" | "version">
  | Omit<Extract<DevtoolsServerEvent, { type: "dev.ready" }>, "id" | "instanceId" | "version">
  | Omit<
      Extract<DevtoolsServerEvent, { type: "hmr.cycle.started" }>,
      "id" | "instanceId" | "version"
    >
  | Omit<
      Extract<DevtoolsServerEvent, { type: "hmr.build.finished" }>,
      "id" | "instanceId" | "version"
    >
  | Omit<
      Extract<DevtoolsServerEvent, { type: "hmr.server.finished" }>,
      "id" | "instanceId" | "version"
    >
  | (DevtoolsBrowserEventInput & { timestamp: number });

export interface DevtoolsSnapshot {
  caches: DevtoolsCacheEntry[];
  events: DevtoolsServerEvent[];
  instance: DevtoolsInstance;
  lastEventId: number;
  routes: DevtoolsRoute[];
  runtime: DevtoolsRuntimeSnapshot;
  sync: DevtoolsSyncSnapshot;
  version: typeof DEVTOOLS_PROTOCOL_VERSION;
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function property(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function hasBrowserEventBase(value: object): boolean {
  return (
    typeof property(value, "clientId") === "string" &&
    isFiniteNumber(property(value, "clientTimestamp"))
  );
}

function isResource(value: unknown): value is DevtoolsResource {
  return (
    isObject(value) &&
    isFiniteNumber(property(value, "decodedBytes")) &&
    isFiniteNumber(property(value, "durationMs")) &&
    isFiniteNumber(property(value, "encodedBytes")) &&
    typeof property(value, "name") === "string" &&
    isFiniteNumber(property(value, "transferredBytes")) &&
    typeof property(value, "type") === "string"
  );
}

function isDevtoolsError(value: unknown): value is DevtoolsError {
  return (
    isObject(value) &&
    isNullableString(property(value, "cause")) &&
    (property(value, "column") === null || isSafeInteger(property(value, "column"))) &&
    isNullableString(property(value, "file")) &&
    isStringArray(property(value, "importChain")) &&
    (property(value, "line") === null || isSafeInteger(property(value, "line"))) &&
    typeof property(value, "message") === "string" &&
    ["hydrate", "import", "loader", "render", "transform"].includes(
      String(property(value, "phase"))
    ) &&
    typeof property(value, "route") === "string" &&
    isNullableString(property(value, "stack"))
  );
}

export function isDevtoolsBrowserEventInput(value: unknown): value is DevtoolsBrowserEventInput {
  if (!(isObject(value) && hasBrowserEventBase(value))) {
    return false;
  }
  const type = property(value, "type");
  if (type === "hmr.client.phase") {
    return (
      isNullableString(property(value, "cycleId")) &&
      (property(value, "durationMs") === null || isFiniteNumber(property(value, "durationMs"))) &&
      isNullableString(property(value, "module")) &&
      ["after-update", "before-update", "paint"].includes(String(property(value, "phase")))
    );
  }
  if (type === "hmr.connection.changed") {
    return ["connected", "connecting", "disconnected", "reconnecting"].includes(
      String(property(value, "state"))
    );
  }
  if (type === "hmr.full-reload") {
    return (
      isNullableString(property(value, "cycleId")) &&
      [
        "development-error-recovered",
        "hmr-connection-recovered",
        "hmr-runtime-unavailable",
        "native-hmr-boundary-missing",
        "unknown-native-hmr-reason",
      ].includes(String(property(value, "reason")))
    );
  }
  if (type === "browser.resources") {
    const resources = property(value, "resources");
    return Array.isArray(resources) && resources.length <= 500 && resources.every(isResource);
  }
  if (type === "sync.connection.changed") {
    return (
      isNullableString(property(value, "cursor")) &&
      ["connected", "connecting", "disabled", "disconnected", "reconnecting"].includes(
        String(property(value, "state"))
      )
    );
  }
  return false;
}

function isDevelopmentServerEvent(value: object, type: unknown): boolean {
  if (type === "dev.error") {
    return isDevtoolsError(property(value, "error")) && isSafeInteger(property(value, "revision"));
  }
  if (type === "dev.ready") {
    return isSafeInteger(property(value, "revision"));
  }
  if (type === "hmr.cycle.started") {
    return (
      typeof property(value, "changedModule") === "string" &&
      typeof property(value, "cycleId") === "string" &&
      isFiniteNumber(property(value, "detectedAt"))
    );
  }
  if (type !== "hmr.build.finished" && type !== "hmr.server.finished") {
    return false;
  }
  return (
    isStringArray(property(value, "changedModules")) &&
    typeof property(value, "cycleId") === "string" &&
    isFiniteNumber(property(value, "detectedAt")) &&
    isFiniteNumber(property(value, "durationMs")) &&
    isStringArray(property(value, "rebuiltModules")) &&
    ["fulfilled", "rejected"].includes(String(property(value, "status"))) &&
    isFiniteNumber(property(value, "startedAt"))
  );
}

export function isDevtoolsServerEvent(value: unknown): value is DevtoolsServerEvent {
  if (
    !(isObject(value) && isSafeInteger(property(value, "id"))) ||
    typeof property(value, "instanceId") !== "string" ||
    !isFiniteNumber(property(value, "timestamp")) ||
    property(value, "version") !== DEVTOOLS_PROTOCOL_VERSION
  ) {
    return false;
  }
  const type = property(value, "type");
  if (
    type === "hmr.client.phase" ||
    type === "hmr.connection.changed" ||
    type === "hmr.full-reload" ||
    type === "browser.resources" ||
    type === "sync.connection.changed"
  ) {
    return isDevtoolsBrowserEventInput(value);
  }
  if (type === "cache.access") {
    return (
      ["isr-loader", "ssg-loader"].includes(String(property(value, "cache"))) &&
      ["hit", "miss", "stale"].includes(String(property(value, "outcome"))) &&
      typeof property(value, "path") === "string"
    );
  }
  if (type === "cache.invalidated") {
    return (
      typeof property(value, "deleted") === "boolean" &&
      isSafeInteger(property(value, "purgedPaths")) &&
      ["path", "source", "tag"].includes(String(property(value, "reason"))) &&
      typeof property(value, "target") === "string"
    );
  }
  if (type === "loader.finished") {
    return (
      isFiniteNumber(property(value, "durationMs")) &&
      isStringArray(property(value, "fieldNames")) &&
      typeof property(value, "loader") === "string" &&
      typeof property(value, "path") === "string" &&
      ["fulfilled", "rejected"].includes(String(property(value, "status")))
    );
  }
  if (type === "payload.serialized") {
    return (
      isSafeInteger(property(value, "bytes")) &&
      ["route-data", "rsc"].includes(String(property(value, "kind"))) &&
      typeof property(value, "path") === "string"
    );
  }
  if (type === "request.finished") {
    return (
      isFiniteNumber(property(value, "durationMs")) &&
      typeof property(value, "path") === "string" &&
      isSafeInteger(property(value, "status"))
    );
  }
  if (type === "request.started") {
    return (
      typeof property(value, "method") === "string" && typeof property(value, "path") === "string"
    );
  }
  return isDevelopmentServerEvent(value, type);
}

function isRuntimeSnapshot(value: unknown): value is DevtoolsRuntimeSnapshot {
  if (!isObject(value)) {
    return false;
  }
  const graph = property(value, "graph");
  const memory = property(value, "memory");
  return (
    isObject(graph) &&
    isSafeInteger(property(graph, "edges")) &&
    isSafeInteger(property(graph, "modules")) &&
    isSafeInteger(property(graph, "revision")) &&
    isObject(memory) &&
    isFiniteNumber(property(memory, "heapBytes")) &&
    isFiniteNumber(property(memory, "rssBytes"))
  );
}

export function isDevtoolsSnapshot(value: unknown): value is DevtoolsSnapshot {
  if (
    !isObject(value) ||
    property(value, "version") !== DEVTOOLS_PROTOCOL_VERSION ||
    !isSafeInteger(property(value, "lastEventId"))
  ) {
    return false;
  }
  const instance = property(value, "instance");
  const sync = property(value, "sync");
  const events = property(value, "events");
  const routes = property(value, "routes");
  const caches = property(value, "caches");
  return (
    isObject(instance) &&
    typeof property(instance, "id") === "string" &&
    typeof property(instance, "prefix") === "string" &&
    isObject(sync) &&
    typeof property(sync, "enabled") === "boolean" &&
    isNullableString(property(sync, "changesPath")) &&
    isRuntimeSnapshot(property(value, "runtime")) &&
    Array.isArray(events) &&
    events.every(isDevtoolsServerEvent) &&
    Array.isArray(routes) &&
    routes.every(
      (route) =>
        isObject(route) &&
        typeof property(route, "file") === "string" &&
        typeof property(route, "hasLoader") === "boolean" &&
        typeof property(route, "hasRequestLoader") === "boolean" &&
        ["isr", "ssg", "ssr"].includes(String(property(route, "mode"))) &&
        typeof property(route, "pattern") === "string" &&
        isStringArray(property(route, "tags"))
    ) &&
    Array.isArray(caches) &&
    caches.every(
      (entry) =>
        isObject(entry) &&
        isFiniteNumber(property(entry, "ageMs")) &&
        isStringArray(property(entry, "dependencies")) &&
        isStringArray(property(entry, "fieldNames")) &&
        typeof property(entry, "id") === "string" &&
        typeof property(entry, "isFresh") === "boolean" &&
        ["isr", "ssg"].includes(String(property(entry, "mode"))) &&
        typeof property(entry, "path") === "string" &&
        (property(entry, "revalidateSeconds") === null ||
          isFiniteNumber(property(entry, "revalidateSeconds")))
    )
  );
}
