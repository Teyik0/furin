import { expect, test } from "bun:test";
import { link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDesktopDevelopmentEntry, loadFurinProject } from "../src/project";

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

test("desktop preload recognizes the configured file through another filesystem name", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-entry-identity-"));
  try {
    await writeFile(
      join(root, "furin.config.ts"),
      'export default { desktop: {}, serverEntry: "server.ts" };'
    );
    await writeFile(join(root, "server.ts"), "export {};");
    await link(join(root, "server.ts"), join(root, "entry.ts"));
    await writeFile(join(root, "other.ts"), "export {};");
    expect(await isDesktopDevelopmentEntry(root, join(root, "entry.ts"))).toBe(true);
    expect(await isDesktopDevelopmentEntry(root, join(root, "other.ts"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
