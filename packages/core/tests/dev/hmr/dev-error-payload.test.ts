import { expect, test } from "bun:test";
import { createDevErrorPayload, publishDevError } from "../../../src/server/dev/error.ts";
import { DevGraph } from "../../../src/server/dev/graph.ts";

test("dev errors preserve cause, source frame, import chain, route, and phase", () => {
  const cause = new Error("database unavailable");
  const error = new Error("loader failed", { cause });
  error.stack = [
    "Error: loader failed",
    "    at load (/workspace/src/pages/index.tsx:12:7)",
    "    at render (/workspace/packages/core/src/server/render.ts:2:1)",
  ].join("\n");

  const payload = createDevErrorPayload(error, {
    entryPath: "/workspace/src/pages/index.tsx",
    importChain: ["/workspace/src/pages/index.tsx", "/workspace/src/data.ts"],
    phase: "loader",
    route: "/dashboard",
  });

  expect(payload).toEqual({
    cause: "database unavailable",
    column: 7,
    file: "/workspace/src/pages/index.tsx",
    importChain: ["/workspace/src/pages/index.tsx", "/workspace/src/data.ts"],
    line: 12,
    message: "loader failed",
    phase: "loader",
    route: "/dashboard",
    stack: error.stack,
  });
});

test("a recorded transform error is ignored outside the current import chain", () => {
  const graph = new DevGraph<null>(null);
  graph.recordImports("/workspace/src/pages/index.tsx", ["/workspace/src/current.ts"]);
  graph.recordSourceError("Unexpected token", {
    column: 3,
    file: "/workspace/src/unrelated.ts",
    line: 7,
  });

  const event = publishDevError(graph, new Error("Unexpected token"), {
    entryPath: "/workspace/src/pages/index.tsx",
    phase: "import",
    route: "/",
  });

  expect(event.error.phase).toBe("import");
  expect(event.error.file).not.toContain("unrelated.ts");
});

test("stack positions support source directories containing parentheses", () => {
  const error = new Error("render failed");
  error.stack = "Error: render failed\n    at render (/workspace/src/(admin)/page.tsx:9:4)";

  const payload = createDevErrorPayload(error, {
    entryPath: "/workspace/src/(admin)/page.tsx",
    importChain: ["/workspace/src/(admin)/page.tsx"],
    phase: "render",
    route: "/admin",
  });

  expect(payload.file).toBe("/workspace/src/(admin)/page.tsx");
  expect(payload.line).toBe(9);
  expect(payload.column).toBe(4);
});
