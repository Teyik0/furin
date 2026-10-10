import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFurinProject } from "../src/project";

test("named Furin configuration resolves serverEntry relative to rootDir", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "furin-project-"));
  try {
    await writeFile(
      join(cwd, "furin.config.ts"),
      'export const rootDir = "app"; export const serverEntry = "backend.ts";'
    );
    expect(await loadFurinProject(cwd)).toEqual({
      root: join(cwd, "app"),
      serverEntry: join(cwd, "app/backend.ts"),
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
