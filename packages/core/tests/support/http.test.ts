import { expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("test ports stay below the ephemeral port range for high process IDs", () => {
  const helperUrl = pathToFileURL(join(import.meta.dir, "http.ts")).href;
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `Object.defineProperty(process, "pid", { value: 35000 }); const { getTestPort } = await import(${JSON.stringify(helperUrl)}); console.log(getTestPort());`,
    ],
  });

  expect(result.exitCode).toBe(0);
  expect(Number(new TextDecoder().decode(result.stdout).trim())).toBeLessThan(32_768);
});
