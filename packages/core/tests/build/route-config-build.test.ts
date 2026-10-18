import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTmpApp, writeAppFile } from "../support/app-fixtures.ts";
import { runCli } from "../support/process.ts";

test("furin build fails on a route config issue and leaves the file untouched", async () => {
  const app = createTmpApp("cli-app");
  const source = [
    'import { defineRoute } from "@teyik0/furin";',
    "",
    "export const route = defineRoute().page(() => <h1>About</h1>);",
    "",
  ].join("\n");
  try {
    writeAppFile(app.path, "src/pages/about.tsx", source);

    const result = await runCli(["build", "--target", "bun"], { cwd: app.path });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      '[furin] src/pages/about.tsx:3:22: defineRoute() must be followed by config(). Add:\n  import { route as rootRoute } from "./root";\n  .config({ layout: rootRoute, mode: "ssg" })'
    );
    expect(readFileSync(join(app.path, "src/pages/about.tsx"), "utf8")).toBe(source);
  } finally {
    app.cleanup();
  }
});
