import { expectTypeOf, test } from "bun:test";
import type { PageCacheAdapter } from "../../src/cache.ts";
import type { FurinOptions } from "../../src/furin.ts";

test("furin accepts a page cache adapter", () => {
  expectTypeOf<PageCacheAdapter>().toExtend<NonNullable<FurinOptions["pageCache"]>>();
});
