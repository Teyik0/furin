import { expect, test } from "bun:test";
import {
  DEVTOOLS_PROTOCOL_VERSION,
  type DevtoolsSnapshot,
  isDevtoolsServerEvent,
  isDevtoolsSnapshot,
} from "../../../src/devtools/protocol.ts";

test("DevTools validators reject previous v2 event and snapshot wire versions", () => {
  const event = {
    id: 1,
    instanceId: "test-instance",
    revision: 1,
    sessionId: "test-session",
    timestamp: 1,
    type: "dev.ready",
    version: DEVTOOLS_PROTOCOL_VERSION,
  } as const;
  const snapshot: DevtoolsSnapshot = {
    caches: [],
    events: [event],
    instance: { id: event.instanceId, prefix: "" },
    lastEventId: event.id,
    routes: [],
    runtime: {
      graph: { edges: 0, modules: 0, revision: 0 },
      memory: { heapBytes: 1024, rssBytes: 2048 },
    },
    sessionId: event.sessionId,
    sync: { changesPath: null, enabled: false },
    version: DEVTOOLS_PROTOCOL_VERSION,
  };

  expect(isDevtoolsServerEvent(event)).toBe(true);
  expect(isDevtoolsSnapshot(snapshot)).toBe(true);
  expect(isDevtoolsServerEvent({ ...event, version: 2 })).toBe(false);
  expect(isDevtoolsSnapshot({ ...snapshot, version: 2 })).toBe(false);
  expect(
    isDevtoolsSnapshot({
      ...snapshot,
      events: [{ ...event, version: 2 }],
    })
  ).toBe(false);
});
