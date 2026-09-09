import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT_PATH = join(import.meta.dirname, "../../../../../scripts/measure-client-bundle.ts");

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { force: true, recursive: true });
    tempDir = undefined;
  }
});

describe("measure-client-bundle", () => {
  test("reports entry and lazy chunks with their source contributions", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "furin-measure-client-"));
    writeFileSync(join(tempDir, "entry.js"), "console.log('entry');");
    writeFileSync(join(tempDir, "lazy.js"), "console.log('lazy');");
    const metafilePath = join(tempDir, "client.json");
    writeFileSync(
      metafilePath,
      JSON.stringify({
        inputs: {},
        outputs: {
          "./entry.js": {
            bytes: 21,
            entryPoint: "src/entry.ts",
            exports: [],
            imports: [{ kind: "dynamic-import", path: "./lazy.js" }],
            inputs: { "src/entry.ts": { bytesInOutput: 21 } },
          },
          "./lazy.js": {
            bytes: 20,
            entryPoint: "src/lazy.ts",
            exports: [],
            imports: [],
            inputs: { "src/lazy.ts": { bytesInOutput: 20 } },
          },
        },
      } satisfies Bun.BuildMetafile)
    );

    const proc = Bun.spawn({
      cmd: ["bun", SCRIPT_PATH, metafilePath, tempDir],
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("./entry.js");
    expect(stdout).toContain("./lazy.js [lazy]");
    expect(stdout).toContain("src/lazy.ts");
    expect(stdout).toContain("dynamic-import → ./lazy.js");
  });
});
