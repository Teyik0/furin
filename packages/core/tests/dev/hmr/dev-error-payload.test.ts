import { expect, test } from "bun:test";
import { createDevErrorPayload } from "../../../src/server/dev/error.ts";

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
