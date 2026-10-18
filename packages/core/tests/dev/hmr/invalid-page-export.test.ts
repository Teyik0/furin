import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRootLayout } from "../../../src/server/router/discovery.ts";
import { resolveCurrentDevRoute } from "../../../src/server/router/hmr.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";

const furinEntry = JSON.stringify(join(import.meta.dir, "../../../src/furin.ts"));
const pagesDir = mkdtempSync(join(tmpdir(), "furin-invalid-page-export-"));

afterAll(() => {
  rmSync(pagesDir, { force: true, recursive: true });
});

test("names the required route export when a page has no page terminal", async () => {
  writeFileSync(
    join(pagesDir, "root.tsx"),
    `import { defineRootRoute } from ${furinEntry};
export const route = defineRootRoute().config({ mode: "ssr" }).layout(({ children }) => children);`
  );
  const pagePath = join(pagesDir, "index.tsx");
  writeFileSync(pagePath, "export const page = () => null;");
  const root = await scanRootLayout(pagesDir);
  const route = {
    mode: "ssr",
    page: { __type: "FURIN_PAGE", _route: { __type: "FURIN_ROUTE" }, component: () => null },
    path: pagePath,
    pattern: "/",
    routeChain: [],
    segmentBoundaries: [],
  } satisfies ResolvedRoute;

  const error = await resolveCurrentDevRoute(route, root).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  expect(String((error as Error).cause)).toContain(
    `${pagePath} must provide a valid Furin page export: \`export const route = defineRoute().config({ layout, mode }).page(...)\``
  );
});
