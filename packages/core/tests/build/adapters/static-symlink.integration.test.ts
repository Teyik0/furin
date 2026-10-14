import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../../src/build/index.ts";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { withBuildStub } from "../../support/with-build-stub.ts";

test("static export copies linked public directories without writing through them", async () => {
  const app = createTmpApp("cli-app");
  const external = mkdtempSync(join(tmpdir(), "furin-static-linked-"));
  try {
    writeFileSync(join(external, "index.html"), "external-original");
    writeFileSync(join(external, "asset.txt"), "linked-asset");
    mkdirSync(join(app.path, "public"), { recursive: true });
    symlinkSync(external, join(app.path, "public/static"), "dir");
    writeAppFile(app.path, "src/pages/static.tsx", [
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      'export const route = defineRoute().config({ layout: rootRoute, mode: "ssg" }).page(() => <main>Static rendered</main>);',
    ].join("\n"));
    await withBuildStub(() => buildApp({ rootDir: app.path, target: "static" }));
    expect(readFileSync(join(external, "index.html"), "utf8")).toBe("external-original");
    expect(lstatSync(join(app.path, "dist/static")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(app.path, "dist/static/index.html"), "utf8")).toContain("Static rendered");
    expect(readFileSync(join(app.path, "dist/static/asset.txt"), "utf8")).toBe("linked-asset");
  } finally {
    app.cleanup();
    rmSync(external, { recursive: true, force: true });
  }
});
