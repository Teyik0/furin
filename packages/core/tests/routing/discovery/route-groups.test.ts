import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRouteTypes } from "../../../src/build/route-types.ts";
import { __resetCompileContext } from "../../../src/server/internal.ts";
import { scanPages } from "../../../src/server/router/discovery.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { mountProductionPages } from "../../support/production-app.ts";
import { expectDefined } from "../../support/utils.ts";

const PAGES_DIR = join(import.meta.dir, "../../fixtures/pages/route-groups");
let originalDevMode: boolean;

beforeAll(() => {
  originalDevMode = IS_DEV;
  __setDevMode(false);
});
afterEach(() => __resetCompileContext());
afterAll(() => __setDevMode(originalDevMode));

test("group layouts render in filesystem order and stay scoped to their pages", async () => {
  const { app } = await mountProductionPages(PAGES_DIR, "");

  const admin = await app.handle(new Request("http://localhost/users/42"));
  if (admin.status !== 200) {
    throw new Error(await admin.text());
  }
  expect(admin.status).toBe(200);
  const adminHtml = await admin.text();
  expect(adminHtml).toContain('data-group="admin"');
  expect(adminHtml).toContain('data-group="settings"');
  expect(adminHtml.indexOf('data-group="admin"')).toBeLessThan(
    adminHtml.indexOf('data-group="settings"')
  );
  expect(adminHtml).toContain("admin<!-- -->:<!-- -->42");
  expect(adminHtml).not.toContain('data-group="marketing"');

  const marketing = await app.handle(new Request("http://localhost/"));
  expect(marketing.status).toBe(200);
  const marketingHtml = await marketing.text();
  expect(marketingHtml).toContain('data-group="marketing"');
  expect(marketingHtml).not.toContain('data-group="admin"');
});

test("group error and not-found boundaries belong only to their descendants", async () => {
  const { routes } = await scanPages(PAGES_DIR);
  const admin = routes.find((route) => route.pattern === "/users/:id");
  const marketing = routes.find((route) => route.pattern === "/");
  expectDefined(admin);
  expectDefined(marketing);

  expect(admin.segmentBoundaries).toHaveLength(1);
  expect(admin.segmentBoundaries[0]?.path).toBe(join(PAGES_DIR, "(admin)").replaceAll("\\", "/"));
  expect(admin.segmentBoundaries[0]?.error).toBe(admin.error);
  expect(admin.segmentBoundaries[0]?.notFound).toBe(admin.notFound);
  expect(admin.error).toBeDefined();
  expect(admin.notFound).toBeDefined();
  expect(marketing.segmentBoundaries).toEqual([]);
  expect(marketing.error).toBeUndefined();
  expect(marketing.notFound).toBeUndefined();
});

test("generated navigation types use public URLs and preserve grouped source imports", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "furin-group-types-"));
  try {
    const { routes } = await scanPages(PAGES_DIR);
    writeRouteTypes(routes, projectRoot);
    const declaration = readFileSync(join(projectRoot, "furin-env.d.ts"), "utf8");

    expect(declaration).toContain('"/users/:id": typeof import(');
    expect(declaration).not.toContain("[path:");
    expect(declaration).toContain("/(admin)/(settings)/users/[id]");
    expect(declaration).not.toContain('"/(admin)/users/:id"');
  } finally {
    rmSync(projectRoot, { force: true, recursive: true });
  }
});
