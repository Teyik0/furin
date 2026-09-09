import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDevFiles } from "../../../src/build/hydrate.ts";

test("unchanged dev artifacts do not report another write", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "furin-dev-files-"));
  const outDir = join(projectRoot, ".furin");
  const log = spyOn(console, "log").mockImplementation(() => undefined);

  try {
    const options = {
      basePath: "",
      clientLogging: false,
      outDir,
      publicPath: "/_client/",
      rootLayout: join(projectRoot, "src/pages/root.tsx"),
      skipRouteTypes: false,
    };
    writeDevFiles([], options, projectRoot);
    writeDevFiles([], options, projectRoot);

    expect(log).toHaveBeenCalledTimes(1);
  } finally {
    log.mockRestore();
    rmSync(projectRoot, { force: true, recursive: true });
  }
});
