import { expect, test } from "bun:test";
import {
  isDevtoolsBrowserEventInput,
  isDevtoolsServerEvent,
} from "../../../src/devtools/protocol.ts";
import { appendDevtoolsEvent, devtoolsEventsSnapshot } from "../../../src/server/devtools/hub.ts";
import { createInstance, withInstance } from "../../../src/server/instance.ts";

test("a new hub resets event IDs without changing logical instance identity", () => {
  const first = createInstance("/session", "/app/pages");
  const second = createInstance("/session", "/app/pages");
  const event = { revision: 1, timestamp: 1, type: "dev.ready" } as const;
  const original = withInstance(first, () => appendDevtoolsEvent(event));
  withInstance(first, () => appendDevtoolsEvent(event));
  const restarted = withInstance(second, () => appendDevtoolsEvent(event));

  expect(original.instanceId).toBe(restarted.instanceId);
  expect(restarted.id).toBe(1);
  expect(original.sessionId).toBeString();
  expect(original.sessionId).not.toBe(restarted.sessionId);
  expect(devtoolsEventsSnapshot(first).sessionId).toBe(original.sessionId);
  expect(devtoolsEventsSnapshot(second).sessionId).toBe(restarted.sessionId);
});

test("hub session and sequence survive module reevaluation on the same instance", async () => {
  const instance = createInstance("/session", "/app/pages");
  const original = withInstance(instance, () =>
    appendDevtoolsEvent({ revision: 1, timestamp: 1, type: "dev.ready" })
  );
  const reevaluated = await import(
    `../../../src/server/devtools/hub.ts?session=${crypto.randomUUID()}`
  );
  const next = withInstance(instance, () =>
    reevaluated.appendDevtoolsEvent({ revision: 2, timestamp: 2, type: "dev.ready" })
  );

  expect(next.sessionId).toBe(original.sessionId);
  expect(next.id).toBe(2);
  expect(reevaluated.devtoolsEventsSnapshot(instance).events).toEqual([original, next]);
});

test("server event validators require session identity", () => {
  const instance = createInstance("/session", "/app/pages");
  const event = withInstance(instance, () =>
    appendDevtoolsEvent({ revision: 1, timestamp: 1, type: "dev.ready" })
  );
  expect(isDevtoolsServerEvent(event)).toBe(true);
  expect(isDevtoolsServerEvent({ ...event, sessionId: undefined })).toBe(false);
  expect(isDevtoolsServerEvent({ ...event, sessionId: 1 })).toBe(false);
});

test("browser phase correlation revisions are optional nonnegative safe integers", () => {
  const event = {
    clientId: "browser",
    clientTimestamp: 1,
    cycleId: null,
    durationMs: null,
    module: null,
    phase: "paint",
    type: "hmr.client.phase",
  };
  expect(isDevtoolsBrowserEventInput(event)).toBe(true);
  expect(isDevtoolsBrowserEventInput({ ...event, correlationRevision: 0 })).toBe(true);
  expect(isDevtoolsBrowserEventInput({ ...event, correlationRevision: 1 })).toBe(true);
  for (const correlationRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
    expect(isDevtoolsBrowserEventInput({ ...event, correlationRevision })).toBe(false);
  }
});
