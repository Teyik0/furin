import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeBuildMetafile } from "../../src/build/shared.ts";
import { createTmpApp } from "../support/app-fixtures.ts";

test("writes the metafile as formatted JSON in a new directory and logs its path", () => {
  const app = createTmpApp("cli-app");
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const path = join(app.path, ".furin/build/analysis/bun-server.json");
    const metafile: Bun.BuildMetafile = { inputs: {}, outputs: {} };

    writeBuildMetafile(path, metafile, "Server");

    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(metafile, null, 2)}\n`);
    expect(log).toHaveBeenCalledWith(`[furin] Server metafile: ${path.replaceAll("\\", "/")}`);
  } finally {
    log.mockRestore();
    app.cleanup();
  }
});
