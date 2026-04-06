import { describe, expect, it } from "bun:test";
import { getProjectRelativePath } from "../src/utils/path.ts";

describe("getProjectRelativePath", () => {
  it("normalizes Windows-style paths before comparing generated files", () => {
    expect(getProjectRelativePath("C:\\tmp\\my-app", "C:\\tmp\\my-app\\package.json")).toBe(
      "package.json"
    );
    expect(getProjectRelativePath("C:\\tmp\\my-app", "C:\\tmp\\my-app\\src\\pages\\root.tsx")).toBe(
      "src/pages/root.tsx"
    );
  });
});
