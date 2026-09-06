/**
 * Multi-instance composition — two `furin()` apps mounted into one parent
 * Elysia under different prefixes. Covers route prefixing, per-instance state
 * isolation (revalidation headers, sync stream injection), the prefix
 * collision guard, per-instance 404s, and the data endpoint under a prefix.
 */
import { expect, test } from "bun:test";

const TESTS_DIR_SUFFIX_RE = /\/tests(?:\/.*)?$/;

test("multi-instance furin composition", () => {
  const coreDir = import.meta.dir.replace(TESTS_DIR_SUFFIX_RE, "");
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin } from "./src/furin.ts";
import { __resetCacheState } from "./src/server/cache/index.ts";
import { __resetCompileContext } from "./src/server/internal.ts";
import {
  __resetTemplateState,
  setProductionTemplateContent,
} from "./src/server/render/template.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { __resetSyncState } from "./src/server/sync/stream.ts";
import {
  migrateSqliteSync,
  sqliteSyncAdapter,
} from "./src/server/sync/sqlite/index.ts";
import { createTmpApp, writeAppFile } from "./tests/support/app-fixtures.ts";

const TEST_TEMPLATE = "<html><body><!--ssr-outlet--></body></html>";
const ACTIVE_ADMIN_NAV_LINK_RE = new RegExp('href="/admin/nav"[^>]*data-status="active"');
const tmpApps = [];
const originalCwd = process.cwd();
const syncDatabase = new Database(":memory:");
migrateSqliteSync(syncDatabase);
const adminSync = {
  adapter: sqliteSyncAdapter({ database: syncDatabase, namespace: "multi-instance-admin" }),
  principal: () => "admin",
};

function resetState() {
  __setDevMode(true);
  __resetTemplateState();
  __resetCompileContext();
  __resetSyncState();
  process.chdir(originalCwd);
  __resetCacheState();
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
}

function rememberTmpApp(app) {
  tmpApps.push(app);
  return app;
}

function writeAdminPages(appPath) {
  writeAppFile(
    appPath,
    "src/admin/root.tsx",
    [
      'import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";',
      "",
      "export const route = defineRootRoute()",
      '  .config({ mode: "ssr" })',
      '  .layout(({ children }) => <html lang="en"><head><HeadContent /></head><body><div data-testid="admin-layout">{children}</div><Scripts /></body></html>);',
    ].join("\\n")
  );
  writeAppFile(
    appPath,
    "src/admin/index.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "ssg" })',
      "  .page(() => <main>Admin home</main>);",
    ].join("\\n")
  );
  writeAppFile(
    appPath,
    "src/admin/nav.tsx",
    [
      'import { Link } from "@teyik0/furin/link";',
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      "",
      'export const route = defineRoute().config({ layout: rootRoute, mode: "ssr" }).page(() => (',
      "    <nav>",
      '      <Link to="/users">Users link</Link>',
      '      <Link to="/nav">Self link</Link>',
      "    </nav>",
      "  ));",
    ].join("\\n")
  );
  writeAppFile(
    appPath,
    "src/admin/users.tsx",
    [
      'import { defineRoute, revalidatePath } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "ssr" })',
      "  .loader(() => {",
      '    revalidatePath("/from-admin", "page");',
      '    return { who: "admin" };',
      "  }).page(() => <main>Admin users</main>);",
    ].join("\\n")
  );
  return join(appPath, "src/admin");
}

async function mountBothApps(options) {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(true);
  process.chdir(app.path);

  writeAppFile(
    app.path,
    "src/pages/revalidating.tsx",
    [
      'import { defineRoute, revalidatePath } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "ssr" })',
      "  .loader(() => {",
      '    revalidatePath("/from-front", "page");',
      "    return {};",
      "  }).page(() => <main>Front revalidating</main>);",
    ].join("\\n")
  );
  writeAppFile(
    app.path,
    "src/pages/nav.tsx",
    [
      'import { Link } from "@teyik0/furin/link";',
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "ssg" })',
      "  .page(() => (",
      "    <nav>",
      '      <Link to="/users">Users link</Link>',
      "    </nav>",
      "  ));",
    ].join("\\n")
  );
  const adminPagesDir = writeAdminPages(app.path);

  setProductionTemplateContent(TEST_TEMPLATE);

  const front = await furin({ pagesDir: join(app.path, "src/pages") });
  const admin = await furin({
    pagesDir: adminPagesDir,
    prefix: "/admin",
    sync: options?.adminSync ? adminSync : undefined,
  });
  const parent = new Elysia().use(front).use(admin);
  return { app, parent };
}

async function runScenario(fn) {
  resetState();
  await fn();
  resetState();
}

try {
  await runScenario(async () => {
    const { parent } = await mountBothApps();

    const frontHome = await parent.handle(new Request("http://furin/"));
    expect(frontHome.status).toBe(200);
    expect(await frontHome.text()).toContain("Home page");

    const adminHome = await parent.handle(new Request("http://furin/admin"));
    expect(adminHome.status).toBe(200);
    const adminHomeHtml = await adminHome.text();
    expect(adminHomeHtml).toContain("Admin home");
    expect(adminHomeHtml).toContain("admin-layout");

    const adminUsers = await parent.handle(new Request("http://furin/admin/users"));
    expect(adminUsers.status).toBe(200);
    expect(await adminUsers.text()).toContain("Admin users");

    const rootUsers = await parent.handle(new Request("http://furin/users"));
    expect(rootUsers.status).toBe(404);
    await rootUsers.text();

    const frontSnapshotResponse = await parent.handle(
      new Request("http://localhost/_furin/devtools/snapshot")
    );
    const adminSnapshotResponse = await parent.handle(
      new Request("http://localhost/admin/_furin/devtools/snapshot")
    );
    expect(frontSnapshotResponse.status).toBe(200);
    expect(adminSnapshotResponse.status).toBe(200);
    const frontSnapshot = await frontSnapshotResponse.json();
    const adminSnapshot = await adminSnapshotResponse.json();
    expect(frontSnapshot.instance.prefix).toBe("");
    expect(adminSnapshot.instance.prefix).toBe("/admin");
    expect(frontSnapshot.instance.id).not.toBe(adminSnapshot.instance.id);

    const adminClient = await parent.handle(
      new Request("http://localhost/admin/_furin/devtools/client.js")
    );
    expect(adminClient.status).toBe(200);
    expect(await adminClient.text()).toContain("furin-devtools");
  });

  await runScenario(async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    __setDevMode(true);
    process.chdir(app.path);
    const adminPagesDir = writeAdminPages(app.path);
    setProductionTemplateContent(TEST_TEMPLATE);

    await furin({ pagesDir: join(app.path, "src/pages") });
    await expect(furin({ pagesDir: adminPagesDir })).rejects.toThrow("already mounted");
  });

  await runScenario(async () => {
    const { parent } = await mountBothApps();

    const [frontRes, adminRes] = await Promise.all([
      parent.handle(new Request("http://furin/revalidating")),
      parent.handle(new Request("http://furin/admin/users")),
    ]);

    expect(frontRes.headers.get("x-furin-revalidate")).toBe("/from-front");
    expect(adminRes.headers.get("x-furin-revalidate")).toBe("/from-admin");
    await frontRes.text();
    await adminRes.text();
  });

  await runScenario(async () => {
    const { parent } = await mountBothApps({ adminSync: true });

    const adminHtml = await (await parent.handle(new Request("http://furin/admin"))).text();
    expect(adminHtml).toContain("__FURIN_SYNC__");
    expect(adminHtml).toContain("/_furin/sync");

    const frontHtml = await (await parent.handle(new Request("http://furin/"))).text();
    expect(frontHtml).not.toContain("__FURIN_SYNC__");
  });

  await runScenario(async () => {
    const { parent } = await mountBothApps({ adminSync: true });

    const prefixed = await parent.handle(new Request("http://furin/admin/_furin/sync/changes"));
    expect(prefixed.status).toBe(200);
    await prefixed.body?.cancel();

    const unprefixed = await parent.handle(new Request("http://furin/_furin/sync/changes"));
    expect(unprefixed.status).toBe(404);
    await unprefixed.text();
  });

  await runScenario(async () => {
    const { parent } = await mountBothApps();

    const res = await parent.handle(new Request("http://furin/admin/_furin/data?path=%2Fusers"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-furin-route");
    expect(await res.text()).toContain("admin");
  });

  await runScenario(async () => {
    const { parent } = await mountBothApps();

    const adminNav = await parent.handle(new Request("http://furin/admin/nav"));
    expect(adminNav.status).toBe(200);
    const adminHtml = await adminNav.text();
    expect(adminHtml).toContain('href="/admin/users"');
    expect(adminHtml).not.toContain('href="/users"');
    expect(adminHtml).toMatch(ACTIVE_ADMIN_NAV_LINK_RE);

    const frontNav = await parent.handle(new Request("http://furin/nav"));
    expect(frontNav.status).toBe(200);
    expect(await frontNav.text()).toContain('href="/users"');
  });

  await runScenario(async () => {
    const { parent } = await mountBothApps();

    const adminMiss = await parent.handle(new Request("http://furin/admin/does-not-exist"));
    expect(adminMiss.status).toBe(404);
    expect(await adminMiss.text()).toContain("404");

    const frontMiss = await parent.handle(new Request("http://furin/does-not-exist"));
    expect(frontMiss.status).toBe(404);
    await frontMiss.text();
  });

  resetState();
  process.exit(0);
} catch (err) {
  console.error(err);
  resetState();
  process.exit(1);
}
      `,
    ],
    cwd: coreDir,
    env: { ...Bun.env, FURIN_RSC_CODEC_PATH: "./dist/rsc/server-codec.js" },
    stderr: "pipe",
    stdout: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(
      ["multi-instance subprocess failed", proc.stdout.toString(), proc.stderr.toString()].join(
        "\n"
      )
    );
  }

  expect(proc.exitCode).toBe(0);
});
