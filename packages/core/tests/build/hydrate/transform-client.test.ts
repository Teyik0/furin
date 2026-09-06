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
