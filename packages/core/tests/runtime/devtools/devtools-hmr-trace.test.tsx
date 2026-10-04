/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { act } from "react";
import type { DevtoolsServerEvent, DevtoolsSnapshot } from "../../../src/devtools/protocol.ts";
import { installDom, uninstallDom } from "../../support/dom.ts";

const session = { sessionId: "trace-session" };

const cycle = {
  ...session,
  changedModules: ["page.tsx"],
  cycleId: "cycle",
  detectedAt: 100,
  durationMs: 10,
  id: 1,
  instanceId: "trace-test",
  rebuiltModules: [],
  startedAt: 100,
  status: "fulfilled",
  timestamp: 110,
  type: "hmr.server.finished",
  version: 2,
} satisfies DevtoolsServerEvent;

function phase(
  clientId: string,
  name: "after-update" | "before-update" | "paint",
  id: number,
  clientTimestamp: number,
  durationMs: number
): DevtoolsServerEvent {
  return {
    ...session,
    clientId,
    clientTimestamp,
    cycleId: cycle.cycleId,
    durationMs,
    id,
    instanceId: cycle.instanceId,
    module: null,
    phase: name,
    timestamp: clientTimestamp,
    type: "hmr.client.phase",
    version: 2,
  };
}

async function withDashboard(
  events: DevtoolsServerEvent[],
  check: (element: HTMLElement) => void
): Promise<void> {
  installDom();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const snapshot: DevtoolsSnapshot = {
    ...session,
    caches: [],
    events,
    instance: { id: cycle.instanceId, prefix: "" },
    lastEventId: events.at(-1)?.id ?? 0,
    routes: [],
    runtime: {
      graph: { edges: 0, modules: 0, revision: 0 },
      memory: { heapBytes: 1024, rssBytes: 2048 },
    },
    sync: { changesPath: null, enabled: false },
    version: 2,
  };
  window.fetch = (() => Promise.resolve(Response.json(snapshot))) as unknown as typeof fetch;
  Reflect.set(window, Symbol.for("furin.browser-events.runtime"), {
    subscribe: () => () => undefined,
    subscribeStatus: (listener: (status: string) => void) => {
      listener("connected");
      return () => undefined;
    },
  });
  const element = document.createElement("div");
  document.body.append(element);
  let unmount = (): void => undefined;
  try {
    const { mountDevtoolsDashboard } = await import("../../../src/devtools/dashboard.tsx");
    await act(async () => {
      unmount = mountDevtoolsDashboard(element);
      await Bun.sleep(50);
    });
    check(element);
  } finally {
    await act(async () => unmount());
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    await uninstallDom();
  }
}

test.serial("the latest paint selects one browser for interleaved HMR timings", async () => {
  await withDashboard(
    [
      cycle,
      phase("browser-a", "before-update", 2, 120, 0),
      phase("browser-b", "before-update", 3, 150, 0),
      phase("browser-a", "after-update", 4, 130, 10),
      phase("browser-a", "paint", 5, 140, 20),
      phase("browser-b", "after-update", 6, 200, 50),
    ],
    (element) => {
      const rows = Array.from(element.querySelectorAll(".waterfall-row"));
      expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual([
        "0.00 ms",
        "20.0 ms",
        "0.00 ms",
        "10.0 ms",
        "10.0 ms",
      ]);
      expect(element.querySelector(".cycle-heading")?.textContent).toContain("browser-a");
    }
  );
});

test.serial("late paint corrections preserve the latest browser's timings and status", async () => {
  await withDashboard(
    [
      cycle,
      phase("browser-a", "before-update", 2, 120, 0),
      phase("browser-a", "after-update", 3, 130, 10),
      phase("browser-b", "before-update", 4, 150, 0),
      phase("browser-b", "after-update", 5, 180, 30),
      phase("browser-b", "paint", 6, 200, 50),
      {
        ...session,
        clientId: "browser-b",
        clientTimestamp: 100,
        id: 7,
        instanceId: cycle.instanceId,
        state: "connected",
        timestamp: 100,
        type: "hmr.connection.changed",
        version: 2,
      },
      {
        ...session,
        clientId: "browser-a",
        clientTimestamp: 210,
        id: 8,
        instanceId: cycle.instanceId,
        state: "disconnected",
        timestamp: 210,
        type: "hmr.connection.changed",
        version: 2,
      },
      {
        ...session,
        clientId: "browser-a",
        clientTimestamp: 220,
        cycleId: cycle.cycleId,
        id: 9,
        instanceId: cycle.instanceId,
        reason: "native-hmr-boundary-missing",
        timestamp: 220,
        type: "hmr.full-reload",
        version: 2,
      },
      phase("browser-a", "paint", 10, 140, 20),
      phase("browser-b", "before-update", 11, 145, 0),
      phase("browser-b", "after-update", 12, 170, 25),
      phase("browser-b", "paint", 13, 190, 45),
    ],
    (element) => {
      expect(element.querySelector(".cycle-heading")?.textContent).toContain("browser-b");
      const rows = Array.from(element.querySelectorAll(".waterfall-row"));
      expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual([
        "0.00 ms",
        "50.0 ms",
        "0.00 ms",
        "30.0 ms",
        "20.0 ms",
      ]);
      expect(element.querySelector(".metrics-grid .metric")?.textContent).toContain("connected");
      expect(element.querySelector(".metrics-grid .metric")?.textContent).not.toContain(
        "disconnected"
      );
      expect(element.querySelector(".reload-callout")).toBeNull();
    }
  );
});

test.serial("phase fallback uses browser chronology and server ids only for ties", async () => {
  await withDashboard(
    [
      cycle,
      phase("browser-b", "before-update", 2, 150, 0),
      phase("browser-b", "after-update", 4, 200, 50),
      phase("browser-a", "after-update", 3, 200, 60),
      phase("browser-a", "before-update", 5, 120, 0),
      phase("browser-a", "after-update", 6, 140, 20),
    ],
    (element) => {
      expect(element.querySelector(".cycle-heading")?.textContent).toContain("browser-b");
      const rows = Array.from(element.querySelectorAll(".waterfall-row"));
      expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual([
        "0.00 ms",
        "50.0 ms",
        "0.00 ms",
        "50.0 ms",
        "0.00 ms",
      ]);
    }
  );
});

test.serial(
  "another tab's connection and reload cannot contaminate the latest phase trace",
  async () => {
    await withDashboard(
      [
        cycle,
        phase("browser-b", "before-update", 2, 120, 0),
        phase("browser-a", "before-update", 3, 130, 0),
        phase("browser-a", "after-update", 4, 140, 10),
        {
          ...session,
          clientId: "browser-a",
          clientTimestamp: 100,
          id: 5,
          instanceId: cycle.instanceId,
          state: "connected",
          timestamp: 100,
          type: "hmr.connection.changed",
          version: 2,
        },
        {
          ...session,
          clientId: "browser-b",
          clientTimestamp: 150,
          id: 6,
          instanceId: cycle.instanceId,
          state: "disconnected",
          timestamp: 150,
          type: "hmr.connection.changed",
          version: 2,
        },
        {
          ...session,
          clientId: "browser-b",
          clientTimestamp: 160,
          cycleId: cycle.cycleId,
          id: 7,
          instanceId: cycle.instanceId,
          reason: "native-hmr-boundary-missing",
          timestamp: 160,
          type: "hmr.full-reload",
          version: 2,
        },
      ],
      (element) => {
        expect(element.querySelector(".cycle-heading")?.textContent).toContain("browser-a");
        expect(element.querySelector(".metrics-grid .metric")?.textContent).toContain("connected");
        expect(element.querySelector(".metrics-grid .metric")?.textContent).not.toContain(
          "disconnected"
        );
        expect(element.querySelector(".reload-callout")).toBeNull();
      }
    );
  }
);

test.serial(
  "a reload-only cycle still labels its browser and shows its reload reason",
  async () => {
    await withDashboard(
      [
        cycle,
        {
          ...session,
          clientId: "browser-a",
          clientTimestamp: 150,
          cycleId: cycle.cycleId,
          id: 2,
          instanceId: cycle.instanceId,
          reason: "native-hmr-boundary-missing",
          timestamp: 150,
          type: "hmr.full-reload",
          version: 2,
        },
      ],
      (element) => {
        expect(element.querySelector(".cycle-heading")?.textContent).toContain("browser-a");
        expect(element.querySelector(".reload-callout")?.textContent).toContain(
          "Full reload · native hmr boundary missing"
        );
      }
    );
  }
);
