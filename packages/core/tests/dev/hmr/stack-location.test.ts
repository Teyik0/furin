import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { stackSourceLocation } from "../../../src/server/dev/stack-location.ts";

describe("stackSourceLocation", () => {
  test("prefers the frame of the entry file over earlier frames", () => {
    const stack = [
      "Error: failed",
      "    at helper (/workspace/src/lib/data.ts:3:5)",
      "    at load (/workspace/src/pages/index.tsx:12:7)",
    ].join("\n");

    expect(stackSourceLocation(stack, "/workspace/src/pages/index.tsx")).toEqual({
      column: 7,
      file: "/workspace/src/pages/index.tsx",
      line: 12,
    });
  });

  test("falls back to the first frame when no frame is in the entry file", () => {
    const stack = "Error: failed\n    at helper (/workspace/src/lib/data.ts:3:5)";

    expect(stackSourceLocation(stack, "/workspace/src/pages/index.tsx")).toEqual({
      column: 5,
      file: "/workspace/src/lib/data.ts",
      line: 3,
    });
  });

  test("maps dev page specifiers, queries and file URLs to source paths", () => {
    const fileUrl = pathToFileURL("/workspace/src/b.tsx").href;
    const stack = [
      "Error: failed",
      "    at render (furin-dev-render:/workspace/src/a.tsx?furin-render&t=1:9:4)",
      `    at page (${fileUrl}:2:1)`,
    ].join("\n");

    expect(stackSourceLocation(stack, "/workspace/src/b.tsx")?.file).toBe("/workspace/src/b.tsx");
    expect(stackSourceLocation(stack, "/workspace/src/a.tsx")?.file).toBe("/workspace/src/a.tsx");
  });

  test("returns undefined without a stack or without positioned frames", () => {
    expect(stackSourceLocation(undefined, "/workspace/src/page.tsx")).toBeUndefined();
    expect(
      stackSourceLocation("Error: failed\n    at <anonymous>", "/workspace/src/page.tsx")
    ).toBeUndefined();
  });
});
