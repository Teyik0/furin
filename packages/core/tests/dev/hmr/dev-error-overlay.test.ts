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
  const app = new Elysia().use(createDevDiagnosticPlugin(store, undefined));

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
  const app = new Elysia().use(createDevDiagnosticPlugin(new DevDiagnosticStore(), undefined));
  const response = await app.handle(
    new Request("http://localhost/_furin/dev/client-errors", {
      body: JSON.stringify({ message: "missing phase" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );

  expect(response.status).toBe(400);
});
