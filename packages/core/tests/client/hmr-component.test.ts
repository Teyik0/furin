import { expect, test } from "bun:test";
import { type HotComponentRegistry, updateHotComponent } from "../../src/client/hmr.ts";

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
  expect(first({ label: "state" })).toBe("second:state");
});
