import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import stripPlugin from "../../../src/plugin/index.ts";
import {
  type DevtoolsClientBuild,
  subscribeDevtoolsClientBuilds,
} from "../../../src/server/devtools/build-observer.ts";
import { withBuildTestLock } from "../../support/build-lock.ts";
import { requireTmpPath, withTmpFiles } from "../../support/tmp-files.ts";

const TMP_DIR = join(import.meta.dir, "../../.tmp-tests/strip-plugin");

test("recreating a deleted client module is reported as a changed build", () =>
  withTmpFiles(
    TMP_DIR,
    { "recreated-page.tsx": "export const value = 1;" },
    async (paths) => {
      type OnEnd = Parameters<Bun.PluginBuilder["onEnd"]>[0];
      type OnLoad = Parameters<Bun.PluginBuilder["onLoad"]>[1];
      type OnStart = Parameters<Bun.PluginBuilder["onStart"]>[0];
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
      const pagePath = requireTmpPath(paths, "recreated-page.tsx");
      const builds: DevtoolsClientBuild[] = [];
      const unsubscribe = subscribeDevtoolsClientBuilds((build) => builds.push(build));
      const runBuild = async (
        startBuild: OnStart,
        loadModule: OnLoad,
        endBuild: OnEnd
      ): Promise<void> => {
        await startBuild();
        await loadModule({
          defer: () => Promise.resolve(),
          loader: "tsx",
          namespace: "file",
          path: pagePath,
        });
        await endBuild({ logs: [], outputs: [], success: true });
      };

      try {
        await runBuild(start, load, end);
        rmSync(pagePath);
        await runBuild(start, load, end);
        writeFileSync(pagePath, "export const value = 2;");
        await runBuild(start, load, end);

        expect(builds).toHaveLength(2);
        expect(builds[0]?.changedModules).toContain(pagePath);
        expect(builds[1]?.changedModules).toContain(pagePath);
      } finally {
        unsubscribe();
      }
    }
  ));

test(
  "the client plugin tombstones a source deleted after resolution",
  () =>
    withBuildTestLock(() =>
      withTmpFiles(
        TMP_DIR,
        {
          "deleted-page.tsx": "export const value = 1;",
          "entry.ts": (paths) => `import ${JSON.stringify(paths["deleted-page.tsx"])};`,
        },
        async (paths) => {
          const deletedPath = requireTmpPath(paths, "deleted-page.tsx");
          rmSync(deletedPath);
          const deletedResolver: Bun.BunPlugin = {
            name: "furin-test-deleted-source",
            setup(build) {
              build.onResolve({ filter: /deleted-page\.tsx$/ }, () => ({
                namespace: "file",
                path: deletedPath,
              }));
            },
          };

          const result = await Bun.build({
            entrypoints: [requireTmpPath(paths, "entry.ts")],
            format: "esm",
            plugins: [deletedResolver, stripPlugin],
            target: "browser",
          });

          expect(result.success).toBe(true);
          expect(result.logs).toEqual([]);
        }
      )
    ),
  { timeout: 30_000 }
);
