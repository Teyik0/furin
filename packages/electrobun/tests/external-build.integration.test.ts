import { expect, test } from "bun:test";
import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { desktopCommand } from "../src/cli";
import { installSdk } from "./fixtures/sdk";
import { createTmpApp } from "./support/core";

test("desktop.external alone preserves package-relative assets after relocation", async () => {
  const fixture = createTmpApp("cli-app");
  try {
    await writeFile(
      join(fixture.path, "package.json"),
      '{"name":"desktop-external-fixture","version":"1.0.0","type":"module"}'
    );
    await installSdk(fixture.path);
    await mkdir(join(fixture.path, "node_modules/@teyik0"), { recursive: true });
    await symlink(
      resolve(import.meta.dir, "../../core"),
      join(fixture.path, "node_modules/@teyik0/furin")
    );
    await writeFile(
      join(fixture.path, "node_modules/electrobun/bin/electrobun.cjs"),
      "process.exit(0);"
    );
    await Promise.all(
      ["native-fixture", "@fixture/native"].map(async (name) => {
        const directory = join(fixture.path, "node_modules", name);
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, "package.json"),
          JSON.stringify({
            name,
            version: "1.0.0",
            type: "module",
            exports: { ".": "./index.js", "./asset": "./index.js" },
          })
        );
        await writeFile(join(directory, "asset.txt"), name);
        await writeFile(
          join(directory, "index.js"),
          'import { readFileSync } from "node:fs"; export const read = () => readFileSync(import.meta.dir + "/asset.txt", "utf8");'
        );
      })
    );
    await writeFile(
      join(fixture.path, "furin.config.ts"),
      'export default { desktop: { app: { name: "Fixture", identifier: "local.furin.externals" }, external: ["native-fixture", "@fixture/native"] } };'
    );
    await writeFile(
      join(fixture.path, "src/server.ts"),
      `import { Elysia } from "elysia";
import { furin } from "@teyik0/furin";
import { desktopApp } from ${JSON.stringify(resolve(import.meta.dir, "../src/server.ts"))};
import { read as first } from "native-fixture";
import { read as second } from "@fixture/native/asset";
export default new Elysia().use(desktopApp())
  .get("/assets", () => [first(), second()])
  .use(await furin({ pagesDir: import.meta.dir + "/pages" }));`
    );
    await writeFile(
      join(fixture.path, "src/pages/index.tsx"),
      `import { defineRoute } from "@teyik0/furin";
import { read as first } from "native-fixture";
import { read as second } from "@fixture/native/asset";
export const route = defineRoute("/").config({ mode: "ssr" })
  .loader(() => ({ message: first() + "|" + second() }))
  .page(({ message }) => <main>{message}</main>);`
    );
    await desktopCommand("build", fixture.path);
    const relocated = join(fixture.path, "relocated");
    await rename(join(fixture.path, ".furin/electrobun/furin"), relocated);
    await rename(join(fixture.path, "src"), join(fixture.path, "source-not-deployed"));
    await rename(
      join(fixture.path, "node_modules"),
      join(fixture.path, "dependencies-not-deployed")
    );
    const transpiler = new Bun.Transpiler({ loader: "js" });
    const rscFiles = [
      ...new Bun.Glob("**/*.js").scanSync({ cwd: join(relocated, "rsc"), absolute: true }),
    ];
    const rscImports = (
      await Promise.all(
        rscFiles.map(async (path) =>
          transpiler.scan(await Bun.file(path).text()).imports.map((entry) => entry.path)
        )
      )
    ).flat();
    expect(rscImports).toContain("native-fixture");
    expect(rscImports).toContain("@fixture/native/asset");
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
        const { default: app } = await import(${JSON.stringify(join(relocated, "app.js"))});
        console.log(JSON.stringify(await (await app.handle(new Request("http://localhost/assets"))).json()));
        console.log(await (await app.handle(new Request("http://localhost/"))).text());
        process.exit(0);
      `,
      ],
      { cwd: relocated, stdout: "pipe", stderr: "pipe", timeout: 10_000 }
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr + stdout).toBe(0);
    expect(stdout).toContain('["native-fixture","@fixture/native"]');
    expect(stdout).toContain("native-fixture|@fixture/native");
  } finally {
    fixture.cleanup();
  }
}, 60_000);
