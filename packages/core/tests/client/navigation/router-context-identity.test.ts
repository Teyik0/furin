import { expect, test } from "bun:test";
import { RouterContext, RouterStoreContext } from "../../../src/client/router/context.ts";

test("duplicate copies of the router context module share the router contexts", async () => {
  // A query string makes Bun evaluate a second, independent module instance.
  const duplicate = new URL("../../../src/client/router/context.ts?duplicate-copy", import.meta.url)
    .href;
  const copy: { RouterContext: unknown; RouterStoreContext: unknown } = await import(duplicate);
  expect(copy.RouterContext).toBe(RouterContext);
  expect(copy.RouterStoreContext).toBe(RouterStoreContext);
});
