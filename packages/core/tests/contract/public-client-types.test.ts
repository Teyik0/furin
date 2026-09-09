import { expect, test } from "bun:test";
// @ts-expect-error — the obsolete page config is not a public contract
import type { PageConfig, RuntimePage, RuntimeRoute } from "../../src/client.ts";

export type InternalTypesAreNotPublic =
  | PageConfig<object, unknown, unknown>
  | RuntimePage
  | RuntimeRoute;

test("the public client entry stays runtime-type free", () => {
  expect(true).toBe(true);
});

test("the public client entry does not expose the legacy route factory", async () => {
  const client = await import("../../src/client.ts");
  expect("createRoute" in client).toBe(false);
});
