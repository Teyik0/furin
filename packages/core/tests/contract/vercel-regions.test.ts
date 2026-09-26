import { expect, expectTypeOf, test } from "bun:test";
import {
  defineConfig,
  type FurinConfig,
  type VercelDeploymentConfig,
  type VercelRegion,
} from "../../src/config";

test("Vercel config suggests supported region codes", () => {
  expectTypeOf<
    NonNullable<NonNullable<FurinConfig["vercel"]>["regions"]>[number]
  >().toEqualTypeOf<VercelRegion>();
  expectTypeOf<
    NonNullable<VercelDeploymentConfig["regions"]>[number]
  >().toEqualTypeOf<VercelRegion>();

  expect(defineConfig({ vercel: { regions: ["cdg1", "fra1"] } }).vercel?.regions).toEqual([
    "cdg1",
    "fra1",
  ]);
  expect(defineConfig({ vercel: { regions: ["dxb1"] } }).vercel?.regions).toEqual(["dxb1"]);

  // @ts-expect-error — abc1 has the right shape but is not a Vercel region.
  defineConfig({ vercel: { regions: ["abc1"] } });
});
