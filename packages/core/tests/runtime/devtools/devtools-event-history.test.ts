import { expect, test } from "bun:test";
import { retainDevtoolsEvent } from "../../../src/devtools/event-history.ts";
import type { DevtoolsServerEvent, DevtoolsSnapshot } from "../../../src/devtools/protocol.ts";

test("live and snapshot phase replay retain only the corrected sample", async () => {
  const provisional = {
    clientId: "browser",
    clientTimestamp: 100,
    correlationRevision: 0,
    cycleId: null,
    durationMs: 10,
    id: 1,
    instanceId: "app",
    module: null,
    phase: "paint",
    sessionId: "session",
    timestamp: 200,
    type: "hmr.client.phase",
    version: 3,
  } satisfies DevtoolsServerEvent;
  const corrected = {
    ...provisional,
    correlationRevision: 1,
    cycleId: "late-cycle",
    id: 2,
  } satisfies DevtoolsServerEvent;
  const current = retainDevtoolsEvent([provisional], corrected);

  expect(current).toEqual([corrected]);
  expect(retainDevtoolsEvent(current, provisional)).toEqual([corrected]);
  expect(retainDevtoolsEvent(current, corrected)).toBe(current);

  const { mergeDevtoolsSnapshotEvents } = await import("../../../src/devtools/dashboard.tsx");
  const snapshot = {
    caches: [],
    events: [provisional],
    instance: { id: "app", prefix: "" },
    lastEventId: 1,
    routes: [],
    runtime: {
      graph: { edges: 0, modules: 0, revision: 0 },
      memory: { heapBytes: 0, rssBytes: 0 },
    },
    sessionId: "session",
    sync: { changesPath: null, enabled: false },
    version: 3,
  } satisfies DevtoolsSnapshot;
  expect(mergeDevtoolsSnapshotEvents(current, snapshot)).toEqual([corrected]);
});
