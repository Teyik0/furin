import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { DevGraph } from "../../../src/server/dev/graph.ts";
import { createDevErrorPlugin, renderDevErrorResponse } from "../../../src/server/dev/plugin.ts";

function waitForMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for WebSocket event")),
      2000
    );
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        resolve(String(event.data));
      },
      { once: true }
    );
  });
}

test("dev error response embeds diagnostics and the overlay client", async () => {
  const graph = new DevGraph<null>(null);
  const event = graph.publishError({
    cause: "missing export",
    column: 4,
    file: "/workspace/src/pages/index.tsx",
    importChain: ["src/pages/index.tsx", "src/card.tsx"],
    line: 9,
    message: "SSR exploded",
    phase: "render",
    route: "/dashboard",
    stack: "Error: SSR exploded",
  });

  const response = renderDevErrorResponse(event, "/admin");
  const html = await response.text();

  expect(response.status).toBe(500);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(html).toContain("SSR exploded");
  expect(html).toContain("src/pages/index.tsx");
  expect(html).toContain("/admin/_furin/dev/error-overlay.js");
  expect(html).not.toContain("Check the server console");
});

test("dev error WebSocket replays errors and publishes successful revisions", async () => {
  const graph = new DevGraph<null>(null);
  graph.publishError({
    cause: null,
    column: null,
    file: "src/pages/index.tsx",
    importChain: ["src/pages/index.tsx"],
    line: null,
    message: "broken",
    phase: "transform",
    route: "/",
    stack: null,
  });
  const app = new Elysia().use(createDevErrorPlugin(graph)).listen(0);
  const port = app.server?.port;
  if (port === undefined) {
    throw new Error("Dev error test server did not start");
  }
  const socket = new WebSocket(`ws://127.0.0.1:${port}/_furin/dev/errors?after=0`);

  try {
    const errorEvent = JSON.parse(await waitForMessage(socket));
    expect(errorEvent.type).toBe("error");
    expect(errorEvent.error.message).toBe("broken");

    const readyMessage = waitForMessage(socket);
    graph.commit(null);
    const readyEvent = JSON.parse(await readyMessage);
    expect(readyEvent.type).toBe("ready");
    expect(readyEvent.revision).toBe(1);
  } finally {
    socket.close();
    await app.stop();
  }
});

test("a cursor from a restarted dev graph replays its current events", () => {
  const previousGraph = new DevGraph<null>(null);
  const previousEvent = previousGraph.publishError({
    cause: null,
    column: null,
    file: "src/pages/index.tsx",
    importChain: ["src/pages/index.tsx"],
    line: null,
    message: "broken before restart",
    phase: "import",
    route: "/",
    stack: null,
  });
  const restartedGraph = new DevGraph<null>(null);
  restartedGraph.publishError({
    cause: null,
    column: null,
    file: "src/pages/index.tsx",
    importChain: ["src/pages/index.tsx"],
    line: null,
    message: "broken after restart",
    phase: "import",
    route: "/",
    stack: null,
  });

  const subscription = restartedGraph.subscribe(
    previousEvent.id,
    previousEvent.serverId,
    () => undefined
  );

  expect(subscription.replay).toHaveLength(1);
  expect(subscription.replay[0]?.type).toBe("error");
  subscription.unsubscribe();
});

test("the overlay client captures hydration failures", async () => {
  const graph = new DevGraph<null>(null);
  const app = new Elysia().use(createDevErrorPlugin(graph));

  const response = await app.handle(new Request("http://localhost/_furin/dev/error-overlay.js"));
  const source = await response.text();

  expect(response.status).toBe(200);
  expect(source).toContain('"furin:hydrate-error"');
  expect(source).toContain('phase: "hydrate"');
  expect(source).toContain("sessionStorage");
  expect(source).toContain("serverId");
  expect(source).toContain("event.serverId !== currentEvent.serverId");
  expect(source).toContain('reportFullReload("development-error-recovered")');
  expect(source).toContain("Cursor persistence is optional.");
  expect(source).not.toContain('window.addEventListener("unhandledrejection"');
});
