import { describe, expect, it } from "bun:test";
import { generateFileTree } from "../src/utils/tree-view.ts";

describe("generateFileTree", () => {
  it("does not duplicate the trailing slash in the root label", () => {
    expect(generateFileTree("my-app/", ["package.json"])[0]).toBe("my-app/");
  });
});
