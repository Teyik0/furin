import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { desktopCommand } from "../src/cli";
import { installSdk } from "./fixtures/sdk";

test("prepare exposes the projected SDK to TypeScript without copying its obsolete baseUrl", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-sdk-types-"));
  try {
    await writeFile(join(root, "package.json"), '{"version":"1.0.0"}');
    await writeFile(
      join(root, "furin.config.ts"),
      `export default {
      desktop: { app: { name: "Types", identifier: "local.furin.types" },
        window: { width: 800, height: 600 }, build: { bun: { entrypoint: "host.ts" } } }
    };`
    );
    await installSdk(root);
    const devkit = join(root, ".furin/electrobun/.hutch/devkit");
    await mkdir(join(devkit, "api"), { recursive: true });
    await writeFile(
      join(devkit, "package.json"),
      JSON.stringify({
        exports: {
          "./main": "./api/main.ts",
          "./main/events": "./api/events.ts",
        },
      })
    );
    await writeFile(join(devkit, "tsconfig.json"), '{"compilerOptions":{"baseUrl":"."}}');
    await writeFile(
      join(devkit, "api/main.ts"),
      'export default { kind: "projected-sdk" as const };'
    );
    await writeFile(join(devkit, "api/events.ts"), 'export const name = "events" as const;');
    await writeFile(join(root, "node_modules/electrobun/bin/electrobun.cjs"), "process.exit(0);");
    await writeFile(
      join(root, "host.ts"),
      `
      import sdk from "electrobun/main";
      import { name } from "electrobun/main/events";
      const kind: "projected-sdk" = sdk.kind;
      const event: "events" = name;
      export { kind, event };
    `
    );
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        extends: "./.furin/electrobun/tsconfig.json",
        compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true },
        files: ["host.ts"],
      })
    );
    await desktopCommand("prepare", root);
    const compiler = join(
      dirname(Bun.resolveSync("typescript/package.json", import.meta.dir)),
      "bin/tsc"
    );
    const child = Bun.spawn([process.execPath, compiler, "-p", join(root, "tsconfig.json")], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stdout + stderr).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
