import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stripPlugin from "../../../src/plugin/index.ts";
import { isPackageModule } from "../../../src/plugin/strip-server.ts";

test("a deleted route remains loadable when its module query version changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "furin-deleted-versioned-route-"));
  const path = join(directory, "route.ts");
  const hydrationPath = join(directory, ".furin/_hydrate.tsx");
  let load: ((args: { path: string }) => unknown) | undefined;
  const builder = {
    onResolve() {},
    onLoad(options: { namespace?: string }, callback: typeof load) {
      if (!options.namespace) {
        load = callback;
      }
    },
  };
  stripPlugin.setup(builder as unknown as Bun.PluginBuilder);
  try {
    mkdirSync(join(directory, ".furin"));
    writeFileSync(
      hydrationPath,
      `import { route } from ${JSON.stringify(`${path}?t=1`)}; export { route };`
    );
    writeFileSync(
      path,
      'import { defineRoute } from "furin"; export const route = defineRoute("/").loader(() => "PRIVATE_DELETED_ROUTE").page(() => "PUBLIC_DELETED_ROUTE");'
    );
    await load?.({ path: hydrationPath });
    const first = await load?.({ path: `${path}?t=1` });
    expect(first).toBeDefined();
    expect(JSON.stringify(first)).not.toContain("PRIVATE_DELETED_ROUTE");
    rmSync(path);
    expect(await load?.({ path: `${path}?t=2` })).toEqual(first);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("the dev client reports a deleted helper instead of serving its cached code", async () => {
  const directory = mkdtempSync(join(tmpdir(), "furin-deleted-helper-"));
  const path = join(directory, "helper.ts");
  let load: ((args: { path: string }) => unknown) | undefined;
  const builder = {
    onResolve() {},
    onLoad(options: { namespace?: string }, callback: typeof load) {
      if (!options.namespace) {
        load = callback;
      }
    },
  };
  stripPlugin.setup(builder as unknown as Bun.PluginBuilder);
  try {
    writeFileSync(path, 'export const value = "deleted helper";');
    expect(await load?.({ path })).toBeDefined();
    rmSync(path);
    await expect(Promise.resolve(load?.({ path }))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("strips a project whose directory name merely contains node_modules", async () => {
  const directory = mkdtempSync(join(tmpdir(), "my_node_modules_app-"));
  const path = join(directory, "route.ts");
  let load: ((args: { path: string }) => unknown) | undefined;
  const builder = {
    onResolve() {},
    onLoad(options: { namespace?: string }, callback: typeof load) {
      if (!options.namespace) {
        load = callback;
      }
    },
  };
  stripPlugin.setup(builder as unknown as Bun.PluginBuilder);
  try {
    writeFileSync(
      path,
      'import { defineRoute } from "furin"; export const route = defineRoute("/").loader(() => "PRIVATE_NESTED_NAME").page(() => null);'
    );
    const loaded = await load?.({ path });
    expect(loaded).toBeDefined();
    expect(JSON.stringify(loaded)).not.toContain("PRIVATE_NESTED_NAME");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test.each([
  ["/srv/app/node_modules/pkg/index.ts", true],
  ["C:\\app\\node_modules\\pkg\\index.ts", true],
  ["/srv/my_node_modules_app/src/route.ts", false],
  ["C:\\srv\\node_modules_cache\\route.ts", false],
])("treats %s as a package module: %p", (path, expected) => {
  expect(isPackageModule(path)).toBe(expected);
});
