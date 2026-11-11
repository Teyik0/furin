import { expect, test } from "bun:test";
import { getDocNeighbors } from "../src/lib/docs";

test("the pager never links across documentation areas", () => {
  expect(getDocNeighbors("/docs/desktop").prev).toBeNull();
  expect(getDocNeighbors("/docs/desktop/migration").next).toBeNull();
  expect(getDocNeighbors("/docs/desktop/architecture")).toMatchObject({
    next: { href: "/docs/desktop/client" },
    prev: { href: "/docs/desktop" },
  });
  expect(getDocNeighbors("/docs/dev-hmr").prev?.href.startsWith("/docs/desktop")).toBe(false);
});
