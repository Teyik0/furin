import { expect, test } from "bun:test";
import { splitDevPage } from "../../../src/plugin/transform-dev-page.ts";

test.each([
  'const label = "local state"; export const route = defineRoute().page(() => <Heavy>{label}</Heavy>);',
  "export const route = defineRoute().page(Heavy);",
  "export const route = anotherBuilder().page(() => <Heavy />);",
  "export const route = defineRoute().page(() => <Heavy value={import.meta.url} />);",
  "const Object = {}; export const route = defineRoute().page(() => <Heavy />);",
  'if (true) { var label = "hoisted state"; } export const route = defineRoute().page(() => <Heavy>{label}</Heavy>);',
  "export const route = defineRoute().page(() => <Heavy />); export const Page = route.component;",
])("keeps unsupported route closures eager: %s", (body) => {
  const source = `import { defineRoute } from "furin"; import Heavy from "./heavy"; ${body}`;
  expect(splitDevPage(source, "/app/page.tsx", "/app/page.tsx?furin-render&t=1")).toBeUndefined();
});

test("recognizes aliased Furin imports and preserves explicit startup effects", () => {
  const source = `
    import { defineRoute as routeBuilder } from "furin";
    import Heavy from "./heavy";
    import "./startup";
    export const route = routeBuilder().page (() => <Heavy />);
  `;
  const split = splitDevPage(source, "/app/page.tsx", "/app/page.tsx?furin-render&t=1");
  expect(split).toBeDefined();
  if (!split) {
    throw new Error("Expected an eligible route to split");
  }
  const scanner = new Bun.Transpiler({ loader: "tsx" });
  expect(scanner.scanImports(split.contract).map((entry) => entry.path)).toContain("./startup");
  expect(scanner.scanImports(split.contract).map((entry) => entry.path)).not.toContain("./heavy");
  const renderImports = scanner.scanImports(split.render).map((entry) => entry.path);
  expect(renderImports).toContain("./heavy");
  expect(renderImports).not.toContain("./startup");
});
