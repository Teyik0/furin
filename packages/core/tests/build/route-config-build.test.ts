import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTmpApp, keyPagesForPrefix, writeAppFile } from "../support/app-fixtures.ts";
import { runCli } from "../support/process.ts";

test("furin build fails on a route config issue and leaves the file untouched", async () => {
  const app = createTmpApp("cli-app");
  const source = [
    'import { defineRoute } from "@teyik0/furin";',
    "",
    'export const route = defineRoute("/about").page(() => <h1>About</h1>);',
    "",
  ].join("\n");
  try {
    writeAppFile(app.path, "src/pages/about.tsx", source);

    const result = await runCli(["build", "--target", "bun"], { cwd: app.path });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      '[furin] src/pages/about.tsx:3:22: defineRoute() must be followed by config(). Add:\n  .config({ mode: "ssg" })'
    );
    expect(readFileSync(join(app.path, "src/pages/about.tsx"), "utf8")).toBe(source);
  } finally {
    app.cleanup();
  }
});

test("furin build expects the prefixed id in an app mounted with a prefix", async () => {
  const app = createTmpApp("cli-app");
  try {
    writeAppFile(
      app.path,
      "src/server.ts",
      `import { furin } from "@teyik0/furin";
import { Elysia } from "elysia";

export default new Elysia().use(await furin({ pagesDir: "./src/pages", prefix: "/shop" }));
`
    );
    writeAppFile(
      app.path,
      "furin.config.ts",
      'export default { apps: [{ pagesDir: "src/pages", prefix: "/shop" }] };\n'
    );
    keyPagesForPrefix(app.path, "src/pages", "/shop");
    writeAppFile(
      app.path,
      "src/pages/about.tsx",
      `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/about")
  .config({ mode: "ssg" })
  .page(() => <h1>About</h1>);
`
    );

    const result = await runCli(["build", "--target", "bun"], { cwd: app.path });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      '[furin] src/pages/about.tsx:3:34: defineRoute("/about") does not match this file. Its id is "/shop/about":\n  defineRoute("/shop/about")'
    );
  } finally {
    app.cleanup();
  }
}, 30_000);
