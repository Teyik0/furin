import { expect, test } from "bun:test";
import { createDevelopmentBrowserEventSources } from "../../../src/server/dev/browser-events.ts";
import { DevDiagnosticStore } from "../../../src/server/dev/diagnostics.ts";
import { appendDevtoolsEvent } from "../../../src/server/devtools/hub.ts";
import { createInstance, withInstance } from "../../../src/server/instance.ts";
import type { BrowserEventEnvelope } from "../../../src/shared/browser-events.ts";

function requestStarted(path: string) {
  return {
    method: "GET",
    operationId: null,
    path,
    requestId: path,
    timestamp: Date.now(),
    type: "request.started" as const,
  };
}

test("development browser events stream only live DevTools events", async () => {
  const instance = createInstance("", "/workspace/pages");
  withInstance(instance, () => appendDevtoolsEvent(requestStarted("/before")));
  const [, source] = createDevelopmentBrowserEventSources(instance, new DevDiagnosticStore());
  if (!source) {
    throw new Error("Expected the DevTools browser event source");
  }
  const received: BrowserEventEnvelope[] = [];
  const subscription = await source.subscribe((event) => received.push(event));

  expect(received).toEqual([]);
  withInstance(instance, () => appendDevtoolsEvent(requestStarted("/after")));
  expect(received).toHaveLength(1);
  expect(received[0]?.channel).toBe("devtools");
  subscription.unsubscribe();
});
