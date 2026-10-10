import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "../../../src/build/index.ts";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { withBuildStub } from "../../support/with-build-stub.ts";

test("Vercel preserves distinct prerenders for root and literal index routes", async () => {
  const app = createTmpApp("cli-app");
  try {
    writeAppFile(app.path, "src/pages/index/index.tsx", [
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as rootRoute } from "../root";',
      'export const route = defineRoute().config({ layout: rootRoute, mode: "ssg" }).page(() => <main>Literal index</main>);',
    ].join("\n"));
    await withBuildStub(() => buildApp({ rootDir: app.path, target: "vercel" }));
    const output = join(app.path, ".vercel/output");
    const config = JSON.parse(readFileSync(join(output, "config.json"), "utf8")) as {
      routes: { src?: string; dest?: string }[];
    };
    const root = config.routes.find(({ src }) => src === "(?<__furin_path>/)");
    const index = config.routes.find(({ src }) => src === "(?<__furin_path>/index)");
    expect(root?.dest).toBeDefined();
    expect(index?.dest).toBeDefined();
    expect(root?.dest).not.toBe(index?.dest);
    for (const route of [root, index]) {
      const name = route?.dest?.split("?")[0]?.slice(1);
      expect(existsSync(join(output, "functions", `${name}.func`))).toBe(true);
      expect(readFileSync(join(output, "functions", `${name}.prerender-fallback.html`), "utf8"))
        .toContain(route === index ? "Literal index" : "Home");
    }
  } finally {
    app.cleanup();
  }
});
