import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stripPlugin from "../../../src/plugin/index.ts";
import {
  type DevtoolsClientBuild,
  subscribeDevtoolsClientBuilds,
} from "../../../src/server/devtools/build-observer.ts";

type OnEnd = Parameters<Bun.PluginBuilder["onEnd"]>[0];
type OnLoad = Parameters<Bun.PluginBuilder["onLoad"]>[1];
type OnStart = Parameters<Bun.PluginBuilder["onStart"]>[0];

async function clientPluginCallbacks(): Promise<{ end: OnEnd; load: OnLoad; start: OnStart }> {
  let end: OnEnd | undefined;
  let load: OnLoad | undefined;
  let start: OnStart | undefined;
  const builder = {
    config: { plugins: [] },
    onEnd(callback: OnEnd) {
      end = callback;
      return builder;
    },
    onLoad(constraints: Bun.PluginConstraints, callback: OnLoad) {
      if (constraints.namespace === undefined && constraints.filter.test("page.tsx")) {
        load = callback;
      }
      return builder;
    },
    onResolve() {
      return builder;
    },
    onStart(callback: OnStart) {
      start = callback;
      return builder;
    },
  } as unknown as Bun.PluginBuilder;
  await stripPlugin.setup(builder);
  if (!(start && load && end)) {
    throw new Error("Expected the client plugin build observers");
  }
  return { end, load, start };
}

function loadArgs(path: string): Bun.OnLoadArgs {
  return { defer: () => Promise.resolve(), loader: "tsx", namespace: "file", path };
}

test("the dev client reports a deleted helper instead of serving its cached code", async () => {
  const directory = mkdtempSync(join(tmpdir(), "furin-deleted-helper-"));
  const path = join(directory, "helper.ts");
  const { load } = await clientPluginCallbacks();
  try {
    writeFileSync(path, "export const value = 1;");
    expect(await load(loadArgs(path))).toBeDefined();
    rmSync(path);
    await expect(Promise.resolve(load(loadArgs(path)))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("recreating a deleted topology module is reported as a changed build", async () => {
  const directory = mkdtempSync(join(tmpdir(), "furin-recreated-route-"));
  const pagePath = join(directory, "page.tsx");
  const hydrationPath = join(directory, ".furin/_hydrate.tsx");
  const { start, load, end } = await clientPluginCallbacks();
  const builds: DevtoolsClientBuild[] = [];
  const unsubscribe = subscribeDevtoolsClientBuilds((build) => builds.push(build));
  const runBuild = async (): Promise<void> => {
    await start();
    await load(loadArgs(pagePath));
    await end({ logs: [], outputs: [], success: true });
  };
  try {
    mkdirSync(join(directory, ".furin"));
    writeFileSync(pagePath, "export const value = 1;");
    writeFileSync(hydrationPath, `import ${JSON.stringify(pagePath)};`);
    await start();
    await load(loadArgs(hydrationPath));
    await load(loadArgs(pagePath));
    await end({ logs: [], outputs: [], success: true });
    rmSync(pagePath);
    await runBuild();
    writeFileSync(pagePath, "export const value = 2;");
    await runBuild();
    expect(builds).toHaveLength(2);
    expect(builds[0]?.changedModules).toContain(pagePath);
    expect(builds[1]?.changedModules).toContain(pagePath);
  } finally {
    unsubscribe();
    rmSync(directory, { force: true, recursive: true });
  }
});
