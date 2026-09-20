import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface VercelReport {
  clientAssetCount: number;
  clientCssBytes: number;
  clientJavaScriptBytes: number;
  serverBootstrapBytes: number;
  serverHandlerBytes: number;
}

const base: VercelReport = {
  clientAssetCount: 9,
  clientCssBytes: 0,
  clientJavaScriptBytes: 299_784,
  serverBootstrapBytes: 2077,
  serverHandlerBytes: 791_141,
};

async function compare(headHandlerBytes: number, versions: [string, string]) {
  const directory = mkdtempSync(join(tmpdir(), "furin-vercel-budget-"));
  try {
    const basePath = join(directory, "base.json");
    const headPath = join(directory, "head.json");
    const markdownPath = join(directory, "report.md");
    writeFileSync(basePath, JSON.stringify(base));
    writeFileSync(headPath, JSON.stringify({ ...base, serverHandlerBytes: headHandlerBytes }));
    const child = Bun.spawn(
      [
        process.execPath,
        "scripts/compare-vercel-framework-reports.ts",
        basePath,
        headPath,
        markdownPath,
        ...versions,
      ],
      {
        cwd: fileURLToPath(new URL("../../../../../", import.meta.url)),
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const exitCode = await child.exited;
    return { exitCode, markdown: await Bun.file(markdownPath).text() };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("uses the explicit one-time server cap for the Elysia 1 to 2 migration", async () => {
  const result = await compare(984_098, ["1.4.30", "2.0.0-beta.16"]);

  expect(result.exitCode).toBe(0);
  expect(result.markdown).toContain("| serverHandlerBytes | 791141 | 984098 | 1000000 | pass |");
  expect(result.markdown).toContain("one-time Elysia 1 → 2 migration cap");
});

test("rejects a Kiana handler above the migration cap", async () => {
  const result = await compare(1_000_001, ["1.4.30", "2.0.0-beta.16"]);

  expect(result.exitCode).toBe(1);
});

test("keeps the relative server budget when the Elysia major is unchanged", async () => {
  const result = await compare(900_000, ["2.0.0-beta.15", "2.0.0-beta.16"]);

  expect(result.exitCode).toBe(1);
  expect(result.markdown).toContain("| serverHandlerBytes | 791141 | 900000 | 834795 | fail |");
  expect(result.markdown).not.toContain("one-time Elysia 1 → 2 migration cap");
});
