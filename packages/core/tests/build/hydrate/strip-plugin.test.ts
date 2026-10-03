import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stripPlugin from "../../../src/plugin/index.ts";

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
