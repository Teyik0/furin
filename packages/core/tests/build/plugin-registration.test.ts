import { expect, test } from "bun:test";
import { join } from "node:path";
import type { BunPlugin } from "bun";
import { buildApp, generateRouteTypes } from "../../src/build/index.ts";
import { createTmpApp, writeAppFile } from "../support/app-fixtures.ts";

const METADATA_IMPORT_RE = /^metadata$/;
const ALL_MODULES_RE = /.*/;

test("buildApp fails with an actionable error when a plugin cannot register at runtime", async () => {
  const app = createTmpApp("cli-app");
  const clientOnlyPlugin: BunPlugin = {
    name: "client-only-plugin",
    setup(build) {
      // Mirrors bun-plugin-tailwind: onBeforeParse exists only in Bun.build().
      (build as unknown as { onBeforeParse: () => void }).onBeforeParse();
    },
  };
  try {
    await expect(
      buildApp({ plugins: [clientOnlyPlugin], rootDir: app.path, target: "bun" })
    ).rejects.toThrow(
      '[furin] Plugin "client-only-plugin" could not be registered for server-side route imports'
    );
    await expect(
      buildApp({ plugins: [clientOnlyPlugin], rootDir: app.path, target: "bun" })
    ).rejects.toThrow("plugins: [{ ...plugin, buildOnly: true }]");
  } finally {
    app.cleanup();
  }
});

test("isolated typegen preserves programmatic plugin closures and virtual module loaders", async () => {
  const app = createTmpApp("cli-app");
  let tag = "first-discovery";
  const plugin: BunPlugin = {
    name: "route-metadata-loader",
    setup(builder) {
      builder.onResolve({ filter: METADATA_IMPORT_RE, namespace: "route-info" }, () => ({
        namespace: "route-info",
        path: "metadata",
      }));
      builder.onLoad({ filter: ALL_MODULES_RE, namespace: "route-info" }, () => ({
        contents: `export const tags = [${JSON.stringify(tag)}];`,
        loader: "js",
      }));
    },
  };
  try {
    writeAppFile(
      app.path,
      "src/pages/index.tsx",
      `import { defineRoute } from "@teyik0/furin";
import { tags } from "route-info:metadata";
export const route = defineRoute("/").config({ mode: "ssg", tags }).page(() => null);`
    );
    const options = { pagesDir: "src/pages", plugins: [plugin], rootDir: app.path };
    await generateRouteTypes(options);
    expect(await Bun.file(join(app.path, "furin-env.d.ts")).text()).toContain(tag);
    tag = "second-discovery";
    await generateRouteTypes(options);
    const declarations = await Bun.file(join(app.path, "furin-env.d.ts")).text();
    expect(declarations).toContain(tag);
    expect(declarations).not.toContain("first-discovery");
  } finally {
    app.cleanup();
  }
});

test.each(["page", "dependency"] as const)(
  "discovery isolates the configured %s loader output",
  async (target) => {
    const app = createTmpApp("cli-app");
    let calls = 0;
    const plugin: BunPlugin = {
      name: `configured-${target}-loader`,
      setup(builder) {
        builder.onLoad(
          { filter: target === "page" ? /[\\/]index\.tsx$/ : /[\\/]_tags\.ts$/ },
          async ({ path }) => {
            calls += 1;
            const source = (await Bun.file(path).text()).replace('"before"', '"configured-tag"');
            return { contents: new TextEncoder().encode(source), loader: "js" };
          }
        );
      },
    };
    try {
      writeAppFile(
        app.path,
        "src/resource.ts",
        'throw new Error("Discovery evaluated a loader dependency"); export const value = "resource";'
      );
      writeAppFile(app.path, "src/pages/_tags.ts", 'export const tags = ["before"];');
      writeAppFile(
        app.path,
        "src/pages/index.tsx",
        `import { defineRoute } from "@teyik0/furin";
import { value } from "../resource";
${target === "dependency" ? 'import { tags } from "./_tags";' : 'const tags = ["before"];'}
export const route = defineRoute("/")
  .config({ mode: "ssr", tags })
  .loader(() => ({ value }))
  .page(() => null);`
      );
      await generateRouteTypes({ pagesDir: "src/pages", plugins: [plugin], rootDir: app.path });
      expect(calls).toBe(1);
      expect(await Bun.file(join(app.path, "furin-env.d.ts")).text()).toContain("configured-tag");
    } finally {
      app.cleanup();
    }
  }
);
