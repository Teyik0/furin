import { expect, spyOn, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type HotComponentRegistry,
  reconcileHotComponentRegistry,
  updateHotComponent,
} from "../../src/client/hmr.ts";

test("a keyed hot component renders without forwarding React's reserved key prop", () => {
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const registry: HotComponentRegistry = new Map();
    const component = updateHotComponent(
      registry,
      "page:/keyed.tsx",
      ({ label }: { label: string }) => label
    );
    expect(renderToStaticMarkup(createElement(component, { key: "page", label: "Keyed" }))).toBe(
      "Keyed"
    );
    expect(errors).not.toHaveBeenCalled();
  } finally {
    errors.mockRestore();
  }
});

test("a hot component keeps its identity while using the latest implementation", () => {
  const registry: HotComponentRegistry = new Map();
  const first = updateHotComponent(
    registry,
    "page:/index.tsx",
    ({ label }: { label: string }) => `first:${label}`
  );
  const second = updateHotComponent(
    registry,
    "page:/index.tsx",
    ({ label }: { label: string }) => `second:${label}`
  );

  expect(second).toBe(first);
  expect(renderToStaticMarkup(createElement(first, { label: "state" }))).toBe("second:state");
});

test("a rebuilt route set removes stale components without replacing surviving slots", () => {
  const registry: HotComponentRegistry = new Map();
  const current = updateHotComponent(registry, "page:/current.tsx", () => "current");
  updateHotComponent(registry, "page:/deleted.tsx", () => "deleted");

  reconcileHotComponentRegistry(registry, new Set(["page:/current.tsx"]));
  const updated = updateHotComponent(registry, "page:/current.tsx", () => "updated");

  expect([...registry.keys()]).toEqual(["page:/current.tsx"]);
  expect(updated).toBe(current);
  expect(renderToStaticMarkup(createElement(current))).toBe("updated");
});
