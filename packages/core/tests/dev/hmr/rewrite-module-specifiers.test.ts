import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewriteModuleSpecifiers } from "../../../src/server/dev/rewrite-module-specifiers.ts";

const MJS_IMPORT_RE = /import value from ".*\/helper\.mjs";/;

function withTempDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "furin-rewrite-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("rewrites specifiers after non-ASCII source without corrupting the module", () => {
  withTempDirectory((directory) => {
    const filePath = join(directory, "route.tsx");
    const code = 'const label = "café";\nimport value from "./value.js";\n';

    expect(rewriteModuleSpecifiers({ code, filePath, versioned: false })).toBe(
      `const label = "café";\nimport value from ${JSON.stringify(join(directory, "value.js"))};\n`
    );
  });
});

test("does not stamp module extensions unsupported by the dev page loader", () => {
  withTempDirectory((directory) => {
    const filePath = join(directory, "route.tsx");
    const helperPath = join(directory, "helper.mjs");
    writeFileSync(helperPath, "export default 1;\n");

    const rewritten = rewriteModuleSpecifiers({
      code: 'import value from "./helper.mjs";\n',
      filePath,
      versioned: true,
    });

    expect(rewritten).toMatch(MJS_IMPORT_RE);
    expect(rewritten).not.toContain("furin-server");
  });
});
