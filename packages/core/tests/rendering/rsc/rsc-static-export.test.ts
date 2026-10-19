import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "../../../src/build/index.ts";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures.ts";

test("static exports render composite server components", async () => {
  const app = createTmpApp("cli-app");
  try {
    writeAppFile(
      app.path,
      "src/pages/rsc.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { CompositeComponent, createCompositeComponent } from "@teyik0/furin/rsc";',
        'import { route as rootRoute } from "./root";',
        "export const route = defineRoute()",
        '  .config({ layout: rootRoute, mode: "ssg" })',
        "  .loader(async () => ({",
        "    shell: await createCompositeComponent<{ action: () => React.ReactNode }>(({ action }) => <main><h1>RSC page</h1>{action()}</main>),",
        "  }))",
        '  .page(({ shell }) => <CompositeComponent src={shell} action={() => <button type="button">Action</button>} />);',
      ].join("\n")
    );

    await buildApp({ rootDir: app.path, staticConfig: { outDir: "dist" }, target: "static" });

    const html = readFileSync(join(app.path, "dist/rsc/index.html"), "utf8");
    expect(html).toContain("RSC page");
    expect(html).toContain('<button type="button">Action</button>');
  } finally {
    app.cleanup();
  }
}, 60_000);
