import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { extractRequestLoaderKeys } from "../../src/build/request-keys.ts";

test("infers private field names from an async loader with a helper and spread", async () => {
  const file = resolve(import.meta.dir, "request-keys.fixture.tsx");
  const keys = await extractRequestLoaderKeys([file]);
  expect(keys.get(file)).toEqual(["permissions", "user"]);
});

test("infers private field names from a reexported route", async () => {
  const file = resolve(import.meta.dir, "request-keys-reexport.fixture.tsx");
  const keys = await extractRequestLoaderKeys([file]);
  expect(keys.get(file)).toEqual(["permissions", "user"]);
});
