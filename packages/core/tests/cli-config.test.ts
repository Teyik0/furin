import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadCliConfig } from "../src/cli/config";
import { createTmpApp, writeAppFile } from "./helpers/tmp-app";

const tmpApps: Array<{ cleanup: () => void }> = [];

function rememberTmpApp<T extends { cleanup: () => void }>(app: T): T {
  tmpApps.push(app);
  return app;
}

afterEach(() => {
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

describe("CLI config resolution", () => {
  test("loadCliConfig uses defaults when no config file is present", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const result = await loadCliConfig(app.path);

    expect(result.configPath).toBeNull();
    expect(result.rootDir).toBe(app.path);
    expect(result.pagesDir).toBe(join(app.path, "src/pages"));
  });

  test("loadCliConfig loads values from furin.config.ts", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeAppFile(
      app.path,
      "furin.config.ts",
      [
        'import { defineConfig } from "@teyik0/furin/config";',
        "export default defineConfig({",
        '  pagesDir: "src/custom-pages",',
        "});",
      ].join("\n")
    );

    const result = await loadCliConfig(app.path);

    expect(result.configPath).toBe(join(app.path, "furin.config.ts"));
    expect(result.pagesDir).toBe(join(app.path, "src/custom-pages"));
  });

  // RED: plugins must survive TypeBox validation and be returned
  test("loadCliConfig preserves plugins array through TypeBox validation", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeAppFile(
      app.path,
      "furin.config.ts",
      [
        'import { defineConfig } from "@teyik0/furin/config";',
        'const mockPlugin: import("@teyik0/furin/config").BunPlugin = { name: "test-plugin", setup() {} };',
        "export default defineConfig({ plugins: [mockPlugin] });",
      ].join("\n")
    );

    const result = await loadCliConfig(app.path);

    expect(result.plugins).toHaveLength(1);
    expect((result.plugins ?? [])[0]?.name).toBe("test-plugin");
  });

  // RED: plugins alongside other fields must not break validation
  test("loadCliConfig preserves plugins alongside other config fields", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeAppFile(
      app.path,
      "furin.config.ts",
      [
        'import { defineConfig } from "@teyik0/furin/config";',
        'const p: import("@teyik0/furin/config").BunPlugin = { name: "p", setup() {} };',
        "export default defineConfig({",
        "  plugins: [p],",
        "});",
      ].join("\n")
    );

    const result = await loadCliConfig(app.path);

    expect((result.plugins ?? [])[0]?.name).toBe("p");
  });
});
