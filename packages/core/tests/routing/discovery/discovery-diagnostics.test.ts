import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  return pagesDir;
}

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "furin-discovery-diagnostics-"));
});

afterAll(() => {
  rmSync(tempDir, { force: true, recursive: true });
});

describe("root.tsx diagnostics", () => {
  test("names the resolved pages directory when root.tsx is missing", async () => {
    const pagesDir = createPagesDir({});

    await expect(scanRootLayout(pagesDir)).rejects.toThrow(
      `[furin] root.tsx: not found in ${pagesDir}.`
    );
  });

  test("refers to defineRootRoute() when the route export is invalid", async () => {
    const pagesDir = createPagesDir({ "root.tsx": "export const route = { notARoute: true };" });

    const error = await scanRootLayout(pagesDir).catch((caught: unknown) => caught);

    expect(String(error)).toContain(
      "root.tsx must export `route = defineRootRoute().config({ mode }).layout(...)`"
    );
    expect(String(error)).not.toContain("defineRoute(");
  });

  test("refers to defineRootRoute() when the root has no layout", async () => {
    const pagesDir = createPagesDir({
      "root.tsx": `import { defineRootRoute } from ${furinEntry};
export const route = defineRootRoute().config({ mode: "ssr" }).page(() => null);`,
    });

    await expect(scanRootLayout(pagesDir)).rejects.toThrow(
      "root.tsx: defineRootRoute() must end with .layout(({ children }) => ...)"
    );
  });
});

describe("convention file diagnostics", () => {
  test("reports an error.tsx without a default export", async () => {
    const pagesDir = createPagesDir({
      "error.tsx": "export function ErrorPage() { return null; }",
      "root.tsx": VALID_ROOT,
    });

    const error = await scanRootLayout(pagesDir).catch((caught: unknown) => caught);

    expect(String(error)).toContain(
      `[furin] ${join(pagesDir, "error.tsx")}: error.tsx must default-export a React component (found exports: ErrorPage).`
    );
    expect(String(error)).toContain(
      "export default function ErrorPage({ error, reset }: ErrorProps)"
    );
  });

  test("reports a not-found.tsx without a default export", async () => {
    const pagesDir = createPagesDir({
      "not-found.tsx": "export const NotFound = () => null;",
      "root.tsx": VALID_ROOT,
    });

    const error = await scanRootLayout(pagesDir).catch((caught: unknown) => caught);

    expect(String(error)).toContain(
      `[furin] ${join(pagesDir, "not-found.tsx")}: not-found.tsx must default-export a React component (found exports: NotFound).`
    );
    expect(String(error)).toContain("export default function NotFound()");
  });
});

describe("nested layout diagnostics", () => {
  const initialDevMode = IS_DEV;

  afterEach(() => {
    __setDevMode(initialDevMode);
  });

  test("reports a _route.tsx that does not export a layout route", async () => {
    __setDevMode(false);
    const pagesDir = createPagesDir({
      "blog/_route.tsx": "export const route = { layout: true };",
      "blog/index.tsx": `import { defineRoute } from ${furinEntry};
export const route = defineRoute("/blog").config({ mode: "ssr" }).page(() => null);`,
      "root.tsx": VALID_ROOT,
    });

    const error = await scanPages(pagesDir).catch((caught: unknown) => caught);

    expect(String(error)).toContain(
      `[furin] ${join(pagesDir, "blog/_route.tsx")}: _route.tsx must export \`route = defineRoute(id).config({ mode }).layout(({ children }) => ...)\`, with the file's id.`
    );
  });
});
