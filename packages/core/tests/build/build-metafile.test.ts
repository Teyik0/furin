import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBuildMetafile } from "../../src/build/shared.ts";

test("writes the metafile as formatted JSON in a new directory and logs its path", () => {
  const root = mkdtempSync(join(tmpdir(), "furin-metafile-"));
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const path = join(root, ".furin/build/analysis/bun-server.json");
    const metafile: Bun.BuildMetafile = { inputs: {}, outputs: {} };

    writeBuildMetafile(path, metafile, "Server");

    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(metafile, null, 2)}\n`);
    expect(log).toHaveBeenCalledWith(`[furin] Server metafile: ${path.replaceAll("\\", "/")}`);
  } finally {
    log.mockRestore();
    rmSync(root, { force: true, recursive: true });
  }
});
