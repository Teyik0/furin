import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadCliConfig } from "../../../src/cli/config";
import { BUILD_TARGETS } from "../../../src/config";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures";

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
  test("only advertises implemented runtime adapters", () => {
    expect(BUILD_TARGETS).toEqual(["bun", "vercel", "static", "package"]);
  });

  test("loadCliConfig uses defaults when no config file is present", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const result = await loadCliConfig(app.path);

    expect(result.configPath).toBeNull();
    expect(result.rootDir).toBe(app.path);
    // pagesDir stays undefined so buildApp can scan server.ts for
    // furin({ pagesDir, prefix }) calls (multi-instance detection).
    expect(result.pagesDir).toBeUndefined();
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

  test("loadCliConfig keeps adapter objects and built-in names in targets", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeAppFile(
      app.path,
      "furin.config.ts",
      [
        'import { defineConfig } from "@teyik0/furin/config";',
        'import { vercel } from "@teyik0/furin/adapters/vercel";',
        'export default defineConfig({ targets: ["bun", vercel({ regions: ["cdg1", "fra1"] })] });',
      ].join("\n")
    );

    const result = await loadCliConfig(app.path);

    expect(
      result.targets?.map((target) => (typeof target === "string" ? target : target.name))
    ).toEqual(["bun", "vercel"]);
  });

  test("loadCliConfig rejects an unknown target name", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeAppFile(app.path, "furin.config.ts", 'export default { targets: ["node"] };');

    await expect(loadCliConfig(app.path)).rejects.toThrow(
      "targets[0] must be one of bun, vercel, static, package, or a deployment adapter object"
    );
  });

  test("vercel() rejects unsupported regions while the config loads", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeAppFile(
      app.path,
      "furin.config.ts",
      [
        'import { vercel } from "@teyik0/furin/adapters/vercel";',
        'export default { targets: [vercel({ regions: ["abc1"] as never })] };',
      ].join("\n")
    );

    await expect(loadCliConfig(app.path)).rejects.toThrow('(got "abc1")');
  });

  test("loadCliConfig reports the removed vercel key", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeAppFile(app.path, "furin.config.ts", 'export default { vercel: { regions: ["cdg1"] } };');

    await expect(loadCliConfig(app.path)).rejects.toThrow('unknown key "vercel"');
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

  test("loadCliConfig rejects a misspelled top-level key and suggests the valid one", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeAppFile(app.path, "furin.config.ts", "export default { reactCompilor: false };");

    await expect(loadCliConfig(app.path)).rejects.toThrow(
      'unknown key "reactCompilor" (path: /reactCompilor). Did you mean "reactCompiler"?'
    );
  });

  test("loadCliConfig rejects unknown nested keys with their full path", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeAppFile(
      app.path,
      "furin.config.ts",
      'export default { apps: [{ pagesDir: "./src/pages" }, { pagesDir: "./src/admin", prefx: "/admin" }] };'
    );

    await expect(loadCliConfig(app.path)).rejects.toThrow(
      'unknown key "prefx" (path: /apps/1/prefx). Did you mean "prefix"?'
    );
  });

  test("loadCliConfig lists valid keys when nothing is close to an unknown key", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeAppFile(app.path, "furin.config.ts", "export default { bun: { minify: true } };");

    await expect(loadCliConfig(app.path)).rejects.toThrow(
      'unknown key "minify" (path: /bun/minify). Valid keys: compile'
    );
  });

  test("loadCliConfig rejects plugins without a name and setup function", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeAppFile(
      app.path,
      "furin.config.ts",
      'export default { plugins: [{ name: "ok", setup() {} }, {}] };'
    );

    await expect(loadCliConfig(app.path)).rejects.toThrow(
      "plugins[1] must be a Bun plugin object: { name: string, setup(build) {} }"
    );
  });
});
