import { expect, expectTypeOf, test } from "bun:test";
import { type VercelAdapterOptions, type VercelRegion, vercel } from "../../src/adapter/vercel";

test("the Vercel adapter suggests supported region codes", () => {
  expectTypeOf<
    NonNullable<VercelAdapterOptions["regions"]>[number]
  >().toEqualTypeOf<VercelRegion>();

  expect(vercel({ regions: ["cdg1", "fra1"] }).name).toBe("vercel");
  expect(vercel({ regions: ["dxb1"] }).name).toBe("vercel");

  // @ts-expect-error — abc1 has the right shape but is not a Vercel region.
  expect(() => vercel({ regions: ["abc1"] })).toThrow('(got "abc1")');
  expect(() => vercel({ regions: [] })).toThrow("non-empty list of distinct Vercel regions");
  expect(() => vercel({ regions: ["cdg1", "cdg1"] })).toThrow(
    "non-empty list of distinct Vercel regions"
  );
});
