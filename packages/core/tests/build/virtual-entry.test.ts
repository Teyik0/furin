import { expect, test } from "bun:test";
import { createVirtualBuildEntry } from "../../src/build/virtual-entry.ts";

test("virtual build entries use the same normalized path for Bun's entrypoint and file map", () => {
  const entry = createVirtualBuildEntry(
    "C:\\work\\app\\.furin\\build\\bun\\_hydrate.tsx",
    "export {};",
    "tsx"
  );

  expect(entry.entrypoint).toBe("C:/work/app/.furin/build/bun/_hydrate.tsx");
  expect(entry.files[entry.entrypoint]).toBe("export {};");
});
