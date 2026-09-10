import { describe, expect, test } from "bun:test";
import MagicString from "magic-string";
import { deadCodeElimination } from "../../../src/plugin/dead-code-elimination";
import { transformForClient } from "../../../src/plugin/transform-client";

describe("transformForClient", () => {
  test("removes server stages and rewrites the builder import", () => {
    const result = transformForClient(
      `import { defineRoute } from "@teyik0/furin";
import { secret } from "./db";
const Page = () => null;
export const route = defineRoute()
  .config({ mode: "ssr", params: schema })
  .loader(() => ({ secret }))
  .head(({ data }) => ({ meta: [{ title: data.secret }] }))
  .page(Page);`,
      "route.tsx"
    );

    expect(result.code).toContain('from "@teyik0/furin/client"');
    expect(result.code).toContain(".page(Page)");
    expect(result.code).not.toContain(".config(");
    expect(result.code).not.toContain(".loader(");
    expect(result.code).not.toContain(".head(");
    expect(result.code).not.toContain("./db");
    expect(result.code).toContain("import.meta.hot.accept");
    expect(result.code).toContain('"route.tsx"');
    expect(result.removedServerCode).toBe(true);
  });

  test("annotates route components with their client hook signature", () => {
    const result = transformForClient(
      `import { useRef, useState } from "react";
import { defineRoute } from "@teyik0/furin";
function Page() {
  const ref = useRef(null);
  const [count] = useState(0);
  return <output ref={ref}>{count}</output>;
}
export const route = defineRoute().loader(() => useServerValue()).page(Page);`,
      "route.tsx"
    );

    expect(result.code).toContain('Symbol.for("furin.hmr.hook-signature")');
    expect(result.code).toContain('["useRef{ref}","useState{[count](0)}"]');
    expect(result.code).not.toContain("useServerValue");
  });

  test("limits the hook signature to the route component", () => {
    const result = transformForClient(
      `import { useEffect, useMemo, useState } from "react";
import { defineRoute } from "@teyik0/furin";
function Helper() {
  useEffect(() => undefined, []);
}
function Child() {
  useMemo(() => 1, []);
  return null;
}
function Page() {
  const [count] = useState(0);
  return <Child>{count}</Child>;
}
export const route = defineRoute().page(Page);`,
      "route.tsx"
    );

    expect(result.code).toContain('["useState{[count](0)}"]');
    expect(result.code).not.toContain('["useEffect","useMemo","useState"]');
  });

  test("changes the hook signature when same-named hook callsites are reordered", () => {
    const transform = (declarations: string) =>
      transformForClient(
        `import { useState } from "react";
import { defineRoute } from "@teyik0/furin";
function Page() {
${declarations}
  return null;
}
export const route = defineRoute().page(Page);`,
        "route.tsx"
      ).code;
    const signature = (code: string): string[] => {
      const value = code.match(/value: (\[[^\n]+\])/u)?.[1];
      if (!value) {
        throw new Error("Expected an emitted hook signature");
      }
      return JSON.parse(value) as string[];
    };

    const first = signature(
      transform('  const [first] = useState("first");\n  const [second] = useState("second");')
    );
    const reordered = signature(
      transform('  const [second] = useState("second");\n  const [first] = useState("first");')
    );

    expect(first).toEqual(['useState{[first]("first")}', 'useState{[second]("second")}']);
    expect(reordered).not.toEqual(first);
  });

  test("renders an imported route component through React Fast Refresh", () => {
    const route = transformForClient(
      `import { defineRoute } from "@teyik0/furin";
import { ImportedPage } from "../components/imported-page";
export const route = defineRoute().page(ImportedPage);`,
      "/app/pages/index.tsx"
    );

    expect(route.code).toContain(
      "import.meta.hot ? (props) => __furinCreateElement(ImportedPage, props) : ImportedPage"
    );
    expect(route.code).toContain("value: []");
  });

  test("avoids collisions with the injected React helper binding", () => {
    const route = transformForClient(
      `import { defineRoute } from "@teyik0/furin";
import { Page } from "../components/page";
const __furinCreateElement = "existing";
export const route = defineRoute().page(Page);`,
      "/app/pages/index.tsx"
    );

    expect(route.code).toContain(
      'import { createElement as __furinCreateElement_1 } from "react"'
    );
    expect(route.code).toContain(
      "import.meta.hot ? (props) => __furinCreateElement_1(Page, props) : Page"
    );
  });

  test("renders an imported namespace route component through React Fast Refresh", () => {
    const route = transformForClient(
      `import { defineRoute } from "@teyik0/furin";
import * as Pages from "../components/pages";
export const route = defineRoute().page(Pages.Page);`,
      "/app/pages/index.tsx"
    );

    expect(route.code).toContain(
      "import.meta.hot ? (props) => __furinCreateElement(Pages.Page, props) : Pages.Page"
    );
    expect(route.code).toContain("value: []");
  });

  test("collects hooks from an inline memo route component", () => {
    const route = transformForClient(
      `import { memo, useState } from "react";
import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().page(memo(function Page() {
  const [count] = useState(0);
  return <output>{count}</output>;
}));`,
      "/app/pages/index.tsx"
    );

    expect(route.code).toContain('value: ["useState{[count](0)}"]');
  });

  test("recognizes a React default imported through a named specifier", () => {
    const route = transformForClient(
      `import { default as React, useState } from "react";
import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().page(React.memo(function Page() {
  const [count] = useState(0);
  return <output>{count}</output>;
}));`,
      "/app/pages/index.tsx"
    );

    expect(route.code).toContain('value: ["useState{[count](0)}"]');
  });

  test.each(["forwardRef", "memo"])(
    "collects hooks from a named route component passed to %s",
    (wrapper) => {
      const route = transformForClient(
        `import { ${wrapper}, useState } from "react";
import { defineRoute } from "@teyik0/furin";
function Page() {
  const [count] = useState(0);
  return <output>{count}</output>;
}
export const route = defineRoute().page(${wrapper}(Page));`,
        "/app/pages/index.tsx"
      );

      expect(route.code).toContain('value: ["useState{[count](0)}"]');
    }
  );

  test("resolves the route component binding in module scope", () => {
    const route = transformForClient(
      `import { useEffect } from "react";
import { defineRoute } from "@teyik0/furin";
import { Page } from "../components/page";
function helper() {
  function Page() {
    useEffect(() => undefined, []);
    return null;
  }
  return Page;
}
export const route = defineRoute().page(Page);`,
      "/app/pages/index.tsx"
    );

    expect(route.code).toContain(
      "import.meta.hot ? (props) => __furinCreateElement(Page, props) : Page"
    );
    expect(route.code).not.toContain('value: ["useEffect{}"]');
  });

  test("does not inject route HMR code when a module only imports the route builder", () => {
    const result = transformForClient(
      `import { defineRoute } from "@teyik0/furin";
export function helper() {
  return defineRoute;
}`,
      "helper.ts"
    );

    expect(result.code).not.toContain("route.component");
    expect(result.code).not.toContain("import.meta.hot.accept");
  });

  test.each(["furin", "@teyik0/furin"])("rewrites separate document imports from %s", (moduleName) => {
    const result = transformForClient(
      `import { HeadContent as Head, Scripts } from "${moduleName}";
import { defineRootRoute } from "${moduleName}";
export const route = defineRootRoute().config({ mode: "ssr" }).layout(({ children }) =>
  <html><head><Head /></head><body>{children}<Scripts /></body></html>);`,
      "root.tsx"
    );

    expect(result.code).not.toContain(`from "${moduleName}"`);
    expect(result.code).toContain(`from "${moduleName}/client"`);
    expect(result.code).toContain("<Head />");
    expect(result.code).toContain("<Scripts />");
  });

  test("supports an aliased defineRoute import", () => {
    const result = transformForClient(
      `import { defineRoute as routeBuilder } from "furin";
const Page = () => null;
export const route = routeBuilder().config({ mode: "ssg" }).page(Page);`,
      "route.tsx"
    );

    expect(result.code).toContain('from "furin/client"');
    expect(result.code).toContain("routeBuilder().page(Page)");
    expect(result.code).not.toContain("mode");
  });

  test("eliminates a parent import used only by config", () => {
    const result = transformForClient(
      `import { defineRoute } from "@teyik0/furin";
import { route as parentRoute } from "./_route";
const Page = () => null;
export const route = defineRoute().config({ layout: parentRoute, mode: "ssr" }).page(Page);`,
      "route.tsx"
    );

    expect(result.code).not.toContain("./_route");
    expect(result.code).toContain("defineRoute().page(Page)");
  });

  test("preserves imports referenced by the terminal component", () => {
    const result = transformForClient(
      `import { defineRoute } from "@teyik0/furin";
import { loaderOnly, Page } from "./feature";
export const route = defineRoute()
  .loader(() => ({ loaderOnly }))
  .page(Page);`,
      "route.tsx"
    );

    expect(result.code).toContain('import { Page } from "./feature"');
    expect(result.code).not.toContain("loaderOnly");
  });

  test("preserves a CSS module binding referenced by JSX", () => {
    const result = transformForClient(
      `import { defineRoute } from "@teyik0/furin";
import styles from "./styles.module.css";
const Page = () => <main className={styles.color}>CSS module</main>;
export const route = defineRoute().config({ mode: "ssr" }).page(Page);`,
      "route.tsx"
    );

    expect(result.code).toContain('import styles from "./styles.module.css"');
    expect(result.code).toContain("className={styles.color}");
  });

  test("does not transform a shadowed local factory", () => {
    const result = transformForClient(
      `import { defineRoute } from "@teyik0/furin";
function local(defineRoute) {
  return defineRoute().loader(() => "local").page(() => null);
}
export const route = defineRoute().page(() => null);`,
      "route.tsx"
    );

    expect(result.code).toContain('.loader(() => "local")');
    expect(result.code).toContain('from "@teyik0/furin/client"');
  });

  test("leaves unrelated code unchanged", () => {
    const result = transformForClient("export const value = 1;", "module.ts");

    expect(result.code).toContain("value = 1");
    expect(result.code).not.toContain("import.meta.hot.accept");
    expect(result.removedServerCode).toBe(false);
  });

  test("supports CRLF source", () => {
    const result = transformForClient(
      'import { defineRoute } from "@teyik0/furin";\r\nexport const route = defineRoute().loader(() => ({})).page(() => null);\r\n',
      "route.tsx"
    );

    expect(result.code).not.toContain(".loader(");
    expect(result.code).toContain(".page(");
  });

  test("passes declaration files through", () => {
    const code = "declare module 'furin' { interface Route {} }";
    expect(transformForClient(code, "furin-env.d.ts")).toEqual({
      code,
      map: null,
      removedServerCode: false,
    });
  });

  test("throws on invalid source", () => {
    expect(() => transformForClient("<<<invalid>>>", "bad.tsx")).toThrow();
  });
});

describe("deadCodeElimination", () => {
  test("preserves module initialization when named bindings become unused", () => {
    const code = 'import { secret } from "./db";\nexport const value = 1;';
    const source = new MagicString(code);

    const result = deadCodeElimination(source, code, "ts").toString();

    expect(result).toContain('import "./db"');
  });

  test("returns transformed input when it cannot be reparsed", () => {
    const source = new MagicString("export const value = 1;");
    source.overwrite(0, source.length(), "<<<invalid>>>");

    expect(deadCodeElimination(source, "export const value = 1;", "ts").toString()).toBe(
      "<<<invalid>>>"
    );
  });
});
