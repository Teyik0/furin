import { expect, test } from "bun:test";
import { HmrUpdateCorrelation } from "../../../src/devtools/hmr-correlation.ts";
import { appendDevtoolsEvent, devtoolsEventsSnapshot } from "../../../src/server/devtools/hub.ts";
import { createInstance, withInstance } from "../../../src/server/instance.ts";

test("late phase corrections replace provisional samples without accepting older HTTP reports", () => {
  const instance = createInstance("", "/correlation/pages");
  withInstance(instance, () => {
    const sample = {
      clientId: "browser",
      clientTimestamp: 100,
      correlationRevision: 0,
      cycleId: null,
      durationMs: 10,
      module: null,
      phase: "paint" as const,
      timestamp: 200,
      type: "hmr.client.phase" as const,
    };
    appendDevtoolsEvent(sample);
    const corrected = { ...sample, correlationRevision: 1, cycleId: "late-cycle" };
    appendDevtoolsEvent(corrected);
    appendDevtoolsEvent(sample);
    const retained = devtoolsEventsSnapshot().events;

    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      clientTimestamp: 100,
      correlationRevision: 1,
      cycleId: "late-cycle",
      durationMs: 10,
    });
  });
});

test("phase revision watermarks outlive unrelated display events", () => {
  const instance = createInstance("", "/watermark/pages");
  withInstance(instance, () => {
    const sample = {
      clientId: "browser",
      clientTimestamp: 100,
      correlationRevision: 1,
      cycleId: "corrected-cycle",
      durationMs: 10,
      module: null,
      phase: "paint" as const,
      timestamp: 200,
      type: "hmr.client.phase" as const,
    };
    const accepted = appendDevtoolsEvent(sample);
    for (let index = 0; index < 1000; index += 1) {
      appendDevtoolsEvent({
        method: "GET",
        operationId: null,
        path: "/unrelated",
        requestId: `request-${index}`,
        timestamp: 300 + index,
        type: "request.started",
      });
    }
    const before = devtoolsEventsSnapshot();
    expect(before.events).toHaveLength(1000);
    expect(before.events.every((event) => event.type === "request.started")).toBe(true);

    expect(appendDevtoolsEvent({ ...sample, correlationRevision: 0, cycleId: null })).toBe(
      accepted
    );
    expect(devtoolsEventsSnapshot()).toEqual(before);

    const corrected = appendDevtoolsEvent({
      ...sample,
      correlationRevision: 2,
      cycleId: "new-cycle",
    });
    expect(corrected.id).toBe(before.lastEventId + 1);
    expect(devtoolsEventsSnapshot().events).toContainEqual(corrected);
  });
});

test("phase watermarks retain 5000 keys and expire the least recently accepted sample", () => {
  const instance = createInstance("", "/bounded-watermark/pages");
  withInstance(instance, () => {
    const sample = {
      clientId: "browser",
      clientTimestamp: 0,
      correlationRevision: 1,
      cycleId: "corrected-cycle",
      durationMs: 10,
      module: null,
      phase: "paint" as const,
      timestamp: 200,
      type: "hmr.client.phase" as const,
    };
    const first = appendDevtoolsEvent(sample);
    for (let index = 1; index < 5000; index += 1) {
      appendDevtoolsEvent({ ...sample, clientTimestamp: index });
    }
    const before = devtoolsEventsSnapshot();
    expect(appendDevtoolsEvent({ ...sample, correlationRevision: 0 })).toBe(first);
    expect(devtoolsEventsSnapshot()).toEqual(before);

    // An accepted correction refreshes retention; rejected reports do not.
    const corrected = appendDevtoolsEvent({ ...sample, correlationRevision: 2 });
    expect(
      appendDevtoolsEvent({ ...sample, clientTimestamp: 1, correlationRevision: 0 })
    ).toMatchObject({ correlationRevision: 1 });
    appendDevtoolsEvent({ ...sample, clientTimestamp: 5000 });
    const after = devtoolsEventsSnapshot();
    expect(appendDevtoolsEvent(sample)).toBe(corrected);
    expect(devtoolsEventsSnapshot()).toEqual(after);

    const expired = appendDevtoolsEvent({
      ...sample,
      clientTimestamp: 1,
      correlationRevision: 0,
    });
    expect(expired.id).toBe(after.lastEventId + 1);
    expect(devtoolsEventsSnapshot().events).toHaveLength(1000);
    expect(devtoolsEventsSnapshot().events).toContainEqual(expired);
  });
});

test("coalesced watcher observations leave a client update explicitly unmatched", () => {
  const instance = createInstance("", "/ambiguous/pages");
  withInstance(instance, () => {
    const correlation = new HmrUpdateCorrelation((sample) => {
      appendDevtoolsEvent({ ...sample, clientId: "browser", timestamp: 200 });
    });
    correlation.begin(100);
    correlation.record(
      {
        cycleId: null,
        durationMs: 5,
        module: null,
        phase: "paint",
        type: "hmr.client.phase",
      },
      105
    );
    correlation.observe("save-a", 90);
    correlation.observe("save-b", 95);

    const retained = devtoolsEventsSnapshot().events;
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      clientTimestamp: 105,
      cycleId: null,
      durationMs: 5,
    });
  });
});
