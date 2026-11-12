import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RouteStyle, scanRouteManifest } from "../../../src/plugin/route-manifest.ts";
import { scanPages, scanRootLayout } from "../../../src/server/router/discovery.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";

const furinEntry = JSON.stringify(join(import.meta.dir, "../../../src/furin.ts"));
const VALID_ROOT = `import { defineRootRoute } from ${furinEntry};
export const route = defineRootRoute().config({ mode: "ssr" }).layout(({ children }) => children);`;

let tempDir: string;
let caseIndex = 0;

function createPagesDir(files: { [relativePath: string]: string }): string {
  caseIndex += 1;
  const pagesDir = join(tempDir, `case-${caseIndex}`);
  mkdirSync(pagesDir, { recursive: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = join(pagesDir, relativePath);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, contents);
  }
  // furin() hands discovery a POSIX pages directory on every platform.
  return pagesDir.replaceAll("\\", "/");
}

function rootOf(pagesDir: string, style: RouteStyle) {
  return scanRootLayout(scanRouteManifest({ pagesDir, prefix: "", style }), pagesDir, style);
}

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "furin-discovery-diagnostics-"));
});

afterAll(() => {
  rmSync(tempDir, { force: true, recursive: true });
});

describe("root layout diagnostics", () => {
  test("names the style's root file and the resolved pages directory when it is missing", async () => {
    const pagesDir = createPagesDir({});

    await expect(rootOf(pagesDir, "tanstack")).rejects.toThrow(
      `[furin] __root.tsx: not found in ${pagesDir}.`
    );
    await expect(rootOf(pagesDir, "nextjs")).rejects.toThrow(
      `[furin] layout.tsx: not found in ${pagesDir}.`
    );
  });

  test("refers to defineRootRoute() when the route export is invalid", async () => {
    const pagesDir = createPagesDir({ "__root.tsx": "export const route = { notARoute: true };" });

    const error = await rootOf(pagesDir, "tanstack").catch((caught: unknown) => caught);

    expect(String(error)).toContain(
      "__root.tsx must export `route = defineRootRoute().config({ mode }).layout(...)`"
    );
    expect(String(error)).not.toContain("defineRoute(");
  });

  test("refers to defineRootRoute() when the root has no layout", async () => {
    const pagesDir = createPagesDir({
      "__root.tsx": `import { defineRootRoute } from ${furinEntry};
export const route = defineRootRoute().config({ mode: "ssr" }).page(() => null);`,
    });

    await expect(rootOf(pagesDir, "tanstack")).rejects.toThrow(
      "__root.tsx: defineRootRoute() must end with .layout(({ children }) => ...)"
    );
  });
});

describe("convention file diagnostics", () => {
  test("reports an error.tsx without a default export", async () => {
    const pagesDir = createPagesDir({
      "error.tsx": "export function ErrorPage() { return null; }",
      "layout.tsx": VALID_ROOT,
    });

    const error = await rootOf(pagesDir, "nextjs").catch((caught: unknown) => caught);

    expect(String(error)).toContain(
      `[furin] ${pagesDir}/error.tsx: error.tsx must default-export a React component (found exports: ErrorPage).`
    );
    expect(String(error)).toContain(
      "export default function ErrorPage({ error, reset }: ErrorProps)"
    );
  });

  test("reports a not-found.tsx without a default export", async () => {
    const pagesDir = createPagesDir({
      "layout.tsx": VALID_ROOT,
      "not-found.tsx": "export const NotFound = () => null;",
    });

    const error = await rootOf(pagesDir, "nextjs").catch((caught: unknown) => caught);

    expect(String(error)).toContain(
      `[furin] ${pagesDir}/not-found.tsx: not-found.tsx must default-export a React component (found exports: NotFound).`
    );
    expect(String(error)).toContain("export default function NotFound()");
  });
});

describe("nested layout diagnostics", () => {
  const initialDevMode = IS_DEV;

  afterEach(() => {
    __setDevMode(initialDevMode);
  });

  test("reports a route.tsx that does not export a layout route", async () => {
    __setDevMode(false);
    const pagesDir = createPagesDir({
      "__root.tsx": VALID_ROOT,
      "blog/index.tsx": `import { defineRoute } from ${furinEntry};
export const route = defineRoute("/blog/").config({ mode: "ssr" }).page(() => null);`,
      "blog/route.tsx": "export const route = { layout: true };",
    });

    const error = await scanPages({ pagesDir, prefix: "", style: "tanstack" }).catch(
      (caught: unknown) => caught
    );

    expect(String(error)).toContain(
      `[furin] ${pagesDir}/blog/route.tsx: a layout file must export \`route = defineRoute(id).config({ mode }).layout(({ children }) => ...)\`, with the file's id.`
    );
  });
});
