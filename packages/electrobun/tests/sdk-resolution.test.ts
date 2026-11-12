import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { desktopCommand } from "../src/cli";
import { prepareSdkResolution, resolveSdk } from "../src/sdk-resolution";
import { installSdk } from "./fixtures/sdk";

test("prepare exposes the projected SDK to TypeScript without copying its obsolete baseUrl", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-sdk-types-"));
  try {
    await writeFile(join(root, "package.json"), '{"version":"1.0.0"}');
    await writeFile(
      join(root, "furin.config.ts"),
      `export default {
      desktop: { app: { name: "Types", identifier: "local.furin.types" }, build: { bun: { entrypoint: "host.ts" } } }
    };`
    );
    await installSdk(root);
    const devkit = join(root, ".furin/electrobun/.hutch/devkit");
    await mkdir(join(devkit, "api"), { recursive: true });
    await writeFile(
      join(devkit, "package.json"),
      JSON.stringify({
        exports: {
          "./main": "./api/sdks/main/index.ts",
          "./main/events": "./api/events.ts",
        },
      })
    );
    await writeFile(join(devkit, "tsconfig.json"), '{"compilerOptions":{"baseUrl":"."}}');
    await mkdir(join(devkit, "api/sdks/main"), { recursive: true });
    await writeFile(
      join(devkit, "api/sdks/main/index.ts"),
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

test.each([
  ["neither include nor files", {}],
  ["its own files", { files: ["src/app.ts"] }],
  ["its own include", { include: ["src/**/*.ts"] }],
])(
  "a project tsconfig with %s checks its sources and the native types",
  async (_shape, selection) => {
    const root = await mkdtemp(join(tmpdir(), "furin-sdk-files-"));
    try {
      const generated = join(root, ".furin/electrobun");
      const devkit = join(generated, ".hutch/devkit");
      await mkdir(join(devkit, "api/sdks/main"), { recursive: true });
      await writeFile(
        join(devkit, "package.json"),
        JSON.stringify({ exports: { "./main": "./api/sdks/main/index.ts" } })
      );
      await writeFile(join(devkit, "api/sdks/main/index.ts"), "export default {};");
      await prepareSdkResolution(generated);
      await writeFile(join(generated, "native-env.d.ts"), "export {};");
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src/app.ts"), "export const app = 1;");
      await writeFile(
        join(root, "tsconfig.json"),
        JSON.stringify({
          extends: "./.furin/electrobun/tsconfig.json",
          compilerOptions: { noEmit: true, types: [] },
          ...selection,
        })
      );
      const compiler = join(
        dirname(Bun.resolveSync("typescript/package.json", import.meta.dir)),
        "bin/tsc"
      );
      const child = Bun.spawn(
        [process.execPath, compiler, "-p", join(root, "tsconfig.json"), "--listFilesOnly"],
        { stdout: "pipe", stderr: "pipe", timeout: 10_000 }
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stdout + stderr).toBe(0);
      const files = stdout.replaceAll("\\", "/");
      expect(files).toContain("/src/app.ts");
      expect(files).toContain("/.furin/electrobun/native-env.d.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

async function installLauncher(root: string, version: string) {
  const directory = join(root, "node_modules/electrobun");
  await mkdir(join(directory, "bin"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "electrobun", version }));
  await writeFile(join(directory, "bin/electrobun.cjs"), "");
}

test("the SDK version comes from the installed launcher it runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-sdk-version-"));
  try {
    await installLauncher(root, "2.0.6");
    const sdk = await resolveSdk(root);
    expect(sdk.version).toBe("2.0.6");
    expect(sdk.launcher).toBe(join(root, "node_modules/electrobun/bin/electrobun.cjs"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an Electrobun release outside the supported range fails with both versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-sdk-range-"));
  try {
    await installLauncher(root, "2.1.0");
    await expect(resolveSdk(root)).rejects.toThrow(
      "electrobun 2.1.0 is installed; Furin supports ~2.0.2"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a devkit whose electrobun/main is not the generated bootstrap's module is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-sdk-contract-"));
  try {
    const generated = join(root, ".furin/electrobun");
    const devkit = join(generated, ".hutch/devkit");
    await mkdir(join(devkit, "api/main"), { recursive: true });
    await writeFile(
      join(devkit, "package.json"),
      JSON.stringify({ exports: { "./main": "./api/main/index.ts" } })
    );
    await writeFile(join(devkit, "api/main/index.ts"), "export default {};");
    await expect(prepareSdkResolution(generated)).rejects.toThrow(
      "Electrobun devkit no longer exposes electrobun/main at ./api/sdks/main/index.ts"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
