import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createDevDiagnostic, DevDiagnosticStore } from "../../../src/server/dev/diagnostics.ts";
import {
  createDevDiagnosticPlugin,
  renderDevDiagnosticResponse,
} from "../../../src/server/dev/plugin.ts";

function renderFailure(store: DevDiagnosticStore) {
  return store.publish(
    createDevDiagnostic(new Error("SSR exploded", { cause: "missing export" }), {
      entryPath: "/workspace/src/pages/index.tsx",
      importChain: ["/workspace/src/pages/index.tsx", "/workspace/src/card.tsx"],
      phase: "render",
      route: "/dashboard",
    })
  );
}

test("dev error response embeds diagnostics and the shared browser event client", async () => {
  const event = renderFailure(new DevDiagnosticStore());
  const response = renderDevDiagnosticResponse(event, "/admin");
  const html = await response.text();

  expect(response.status).toBe(500);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(html).toContain("SSR exploded");
  expect(html).toContain("src/pages/index.tsx");
  expect(html).toContain("/admin/_furin/events/client.js");
  expect(html).toContain("/admin/_furin/dev/overlay.js");
  expect(html).not.toContain("Check the server console");
});

test("the overlay client captures hydration and client-render failures", async () => {
  const store = new DevDiagnosticStore();
  const app = new Elysia().use(createDevDiagnosticPlugin(store, undefined, undefined));

  const response = await app.handle(new Request("http://localhost/_furin/dev/overlay.js"));
  const source = await response.text();

  expect(response.status).toBe(200);
  expect(source).toContain('"furin:client-error"');
  expect(source).toContain("reportClientError(detail)");
  expect(source).toContain("/_furin/dev/client-errors");
  expect(source).toContain("furin.browser-events.runtime");
  expect(source).not.toContain("/_furin/dev/errors");
});

test("invalid browser diagnostics are rejected", async () => {
  const app = new Elysia().use(
    createDevDiagnosticPlugin(new DevDiagnosticStore(), undefined, undefined)
  );
  const response = await app.handle(
    new Request("http://localhost/_furin/dev/client-errors", {
      body: JSON.stringify({ message: "missing phase" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );

  expect(response.status).toBe(400);
});

test("reconciles route diagnostics before publishing a browser error", async () => {
  const store = new DevDiagnosticStore();
  renderFailure(store);
  const app = new Elysia().use(
    createDevDiagnosticPlugin(store, undefined, () => {
      expect(store.markReady("/dashboard")).toBeDefined();
      return Promise.resolve();
    })
  );

  const response = await app.handle(
    new Request("http://localhost/_furin/dev/client-errors", {
      body: JSON.stringify({
        message: "client render exploded",
        phase: "client-render",
        route: "/dashboard",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  const event = await response.json();
  const subscription = store.subscribe(0, undefined, () => undefined);

  expect(response.status).toBe(200);
  expect(event).toMatchObject({
    diagnostic: { message: "client render exploded" },
    type: "error",
  });
  expect(subscription.replay).toHaveLength(1);
  expect(subscription.replay[0]).toMatchObject({
    diagnostic: { message: "client render exploded" },
    type: "error",
  });
  subscription.unsubscribe();
});
