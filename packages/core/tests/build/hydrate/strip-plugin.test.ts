import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import stripPlugin from "../../../src/plugin/index.ts";
import { withBuildTestLock } from "../../support/build-lock.ts";
import { requireTmpPath, withTmpFiles } from "../../support/tmp-files.ts";

const TMP_DIR = join(import.meta.dir, "../../.tmp-tests/strip-plugin");

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
