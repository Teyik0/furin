import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { scanElyraInstances } from "../src/build/scan-server";

// Helpers — write a temp file, scan it, clean up
async function withTmpFile(content: string, fn: (path: string) => void): Promise<void> {
  const path = join(
    import.meta.dir,
    `_scan-tmp-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.ts`
  );
  await Bun.write(path, content);
  try {
    fn(path);
  } finally {
    rmSync(path, { force: true });
  }
}

describe("scanElyraInstances", () => {
  test("detects a single elyra() with a string literal pagesDir", async () => {
    await withTmpFile(
      `
import { elyra } from "elyra";
import Elysia from "elysia";
new Elysia().use(elyra({ pagesDir: "./src/pages" })).listen(3000);
`,
      (path) => {
        const result = scanElyraInstances(path);
        expect(result).toEqual(["./src/pages"]);
      }
    );
  });

  test("detects multiple elyra() instances with different pageDirs", async () => {
    await withTmpFile(
      `
import { elyra } from "elyra";
import Elysia from "elysia";
new Elysia()
  .use(elyra({ pagesDir: "./src/pages/public" }))
  .use(elyra({ pagesDir: "./src/pages/admin" }))
  .listen(3000);
`,
      (path) => {
        const result = scanElyraInstances(path);
        expect(result).toEqual(["./src/pages/public", "./src/pages/admin"]);
      }
    );
  });

  test("returns [] for a template literal pagesDir (dynamic path)", async () => {
    await withTmpFile(
      `
import { elyra } from "elyra";
import Elysia from "elysia";
new Elysia().use(elyra({ pagesDir: \`\${import.meta.dir}/pages\` })).listen(3000);
`,
      (path) => {
        const result = scanElyraInstances(path);
        expect(result).toEqual([]);
      }
    );
  });

  test("returns [] for a variable pagesDir (dynamic path)", async () => {
    await withTmpFile(
      `
import { elyra } from "elyra";
import Elysia from "elysia";
const dir = "./src/pages";
new Elysia().use(elyra({ pagesDir: dir })).listen(3000);
`,
      (path) => {
        const result = scanElyraInstances(path);
        expect(result).toEqual([]);
      }
    );
  });

  test("ignores elyra() calls without a pagesDir property", async () => {
    await withTmpFile(
      `
import { elyra } from "elyra";
import Elysia from "elysia";
new Elysia().use(elyra({})).listen(3000);
`,
      (path) => {
        const result = scanElyraInstances(path);
        expect(result).toEqual([]);
      }
    );
  });

  test("returns [] when no elyra() calls exist", async () => {
    await withTmpFile(
      `
import Elysia from "elysia";
new Elysia().listen(3000);
`,
      (path) => {
        const result = scanElyraInstances(path);
        expect(result).toEqual([]);
      }
    );
  });
});
