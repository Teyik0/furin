import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { resolve } from "node:path";
import { createContext } from "../src/pipeline/context.ts";
import { stage2Selection } from "../src/pipeline/stages/2-selection.ts";
import { stage4Deps } from "../src/pipeline/stages/4-deps.ts";

const corePackagePath = resolve(import.meta.dir, "../../../packages/core/package.json");

afterEach(() => {
  spyOn(globalThis, "fetch").mockRestore();
});

describe("stage4Deps", () => {
  it("falls back to the Furin version this scaffolder ships with when npm is unreachable", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const { version }: { version: string } = await Bun.file(corePackagePath).json();
    const ctx = createContext({ templateId: "simple" });
    await stage2Selection(ctx);

    await stage4Deps(ctx);

    expect(ctx.furinVersion).toBe(`^${version}`);
    expect(ctx.dependencies["@teyik0/furin"]).toBe(`^${version}`);
  });
});
