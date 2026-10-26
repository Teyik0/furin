import { expect, test } from "bun:test";
import { join } from "node:path";
import { generateRouteTypes } from "../../src/build/index.ts";
import { createTmpApp, writeAppFile } from "../support/app-fixtures.ts";

test.each([
  'export const childTags = ["shared-metadata"];',
  'const tags = ["shared-metadata"]; export { tags as childTags };',
  'export { childTags } from "./_shared";',
])("discovery preserves shared metadata exports: %s", async (declaration) => {
  const app = createTmpApp("cli-app");
  try {
    writeAppFile(
      app.path,
      "src/resource.ts",
      'throw new Error("Discovery evaluated a loader dependency"); export const value = "resource";'
    );
    writeAppFile(app.path, "src/pages/_shared.ts", 'export const childTags = ["shared-metadata"];');
    writeAppFile(
      app.path,
      "src/pages/root.tsx",
      `import { defineRootRoute } from "@teyik0/furin";
import { value } from "../resource";
const privateValue = value;
${declaration}
export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .loader(() => ({ value: privateValue }))
  .layout(({ children }) => children);`
    );
    writeAppFile(
      app.path,
      "src/pages/index.tsx",
      `import { defineRoute } from "@teyik0/furin";
import { childTags } from "./root";
export const route = defineRoute("/").config({ mode: "ssr", tags: childTags }).page(() => null);`
    );
    await generateRouteTypes({ pagesDir: "src/pages", rootDir: app.path });
    expect(await Bun.file(join(app.path, "furin-env.d.ts")).text()).toContain("shared-metadata");
  } finally {
    app.cleanup();
  }
});

test.each(["enum", "const enum"])(
  "discovery retains configuration %s declarations",
  async (kind) => {
    const app = createTmpApp("cli-app");
    try {
      writeAppFile(
        app.path,
        "src/pages/index.tsx",
        `import { defineRoute } from "@teyik0/furin";
${kind} PageMode { Ssr = "ssr" }
${kind} Tag { Shared = "enum-metadata" }
export const route = defineRoute("/")
  .config({ mode: PageMode.Ssr, tags: [Tag.Shared] })
  .page(() => null);`
      );
      await generateRouteTypes({ pagesDir: "src/pages", rootDir: app.path });
      expect(await Bun.file(join(app.path, "furin-env.d.ts")).text()).toContain("enum-metadata");
    } finally {
      app.cleanup();
    }
  }
);

test.each([
  'const tags = []; tags.push("imperative-metadata");',
  'let tags; if (true) { tags = ["imperative-metadata"]; }',
  'const tags = []; function initialize() { tags.push("imperative-metadata"); } initialize();',
  'const tags = []; const initialized = tags.push("imperative-metadata");',
  'const tags = []; class View { static { tags.push("imperative-metadata"); } }',
])("discovery preserves configuration initialization: %s", async (initialization) => {
  const app = createTmpApp("cli-app");
  try {
    writeAppFile(
      app.path,
      "src/pages/index.tsx",
      `import { defineRoute } from "@teyik0/furin";
${initialization}
export const route = defineRoute("/")
  .config({ mode: "ssr", tags })
  .page(() => { ${initialization.includes("class View") ? "void View;" : ""} return null; });`
    );
    await generateRouteTypes({ pagesDir: "src/pages", rootDir: app.path });
    expect(await Bun.file(join(app.path, "furin-env.d.ts")).text()).toContain(
      "imperative-metadata"
    );
  } finally {
    app.cleanup();
  }
});

test.each(["namespace", "module"])(
  "discovery retains runtime TypeScript %s configuration",
  async (kind) => {
    const app = createTmpApp("cli-app");
    try {
      writeAppFile(
        app.path,
        "src/pages/index.tsx",
        `import { defineRoute } from "@teyik0/furin";
${kind} Meta { export const mode = "ssr"; export const tags = ["namespace-metadata"]; }
export const route = defineRoute("/").config({ mode: Meta.mode, tags: Meta.tags }).page(() => null);`
      );
      await generateRouteTypes({ pagesDir: "src/pages", rootDir: app.path });
      expect(await Bun.file(join(app.path, "furin-env.d.ts")).text()).toContain(
        "namespace-metadata"
      );
    } finally {
      app.cleanup();
    }
  }
);

test.each(["error", "not-found"])("discovery preserves %s boundary metadata", async (boundary) => {
  const app = createTmpApp("cli-app");
  try {
    writeAppFile(
      app.path,
      "src/resource.ts",
      'throw new Error("Discovery evaluated a boundary component dependency"); export const value = "resource";'
    );
    writeAppFile(
      app.path,
      `src/pages/${boundary}.tsx`,
      `import { value } from "../resource";
export const childTags = ["boundary-metadata"];
export default function Boundary() { return <main>{value}</main>; }`
    );
    writeAppFile(
      app.path,
      "src/pages/index.tsx",
      `import { defineRoute } from "@teyik0/furin";
import { childTags } from "./${boundary}";
export const route = defineRoute("/").config({ mode: "ssr", tags: childTags }).page(() => null);`
    );
    await generateRouteTypes({ pagesDir: "src/pages", rootDir: app.path });
    expect(await Bun.file(join(app.path, "furin-env.d.ts")).text()).toContain("boundary-metadata");
  } finally {
    app.cleanup();
  }
});

test.each(["method", "field"])(
  "discovery preserves boundary class initialization with a render %s",
  async (kind) => {
    const app = createTmpApp("cli-app");
    try {
      writeAppFile(
        app.path,
        "src/resource.ts",
        'throw new Error("Discovery evaluated boundary rendering"); export const value = "resource";'
      );
      writeAppFile(
        app.path,
        "src/pages/error.tsx",
        `import { Component } from "react";
import { value } from "../resource";
export const childTags = [];
export default class Boundary extends Component {
  static { childTags.push("boundary-class-metadata"); }
  ${kind === "method" ? "render() { return <main>{value}</main>; }" : "render = () => <main>{value}</main>;"}
}`
      );
      writeAppFile(
        app.path,
        "src/pages/index.tsx",
        `import { defineRoute } from "@teyik0/furin";
import { childTags } from "./error";
export const route = defineRoute("/").config({ mode: "ssr", tags: childTags }).page(() => null);`
      );
      await generateRouteTypes({ pagesDir: "src/pages", rootDir: app.path });
      expect(await Bun.file(join(app.path, "furin-env.d.ts")).text()).toContain(
        "boundary-class-metadata"
      );
    } finally {
      app.cleanup();
    }
  }
);
