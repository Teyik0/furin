import { expect, test } from "bun:test";
import { transformForClient } from "../../../src/plugin/transform-client.ts";
import { splitDevPage } from "../../../src/plugin/transform-dev-page.ts";
import { transformIsomorphicFunctions } from "../../../src/plugin/transform-isomorphic.ts";

// Bun's onLoad ignores returned sourcemaps: stack traces only match the
// source when the transforms keep every surviving line in place.
function lineOf(code: string, marker: string): number {
  const index = code.indexOf(marker);
  if (index < 0) {
    throw new Error(`${marker} is missing from:\n${code}`);
  }
  return code.slice(0, index).split("\n").length;
}

const ROUTE = `import { defineRoute } from "@teyik0/furin";
import {
  listPosts,
  countPosts,
} from "./db";
import { Card } from "./card";

const loadPosts = async () => {
  const posts = await listPosts();
  return { count: await countPosts(), posts };
};

export const route = defineRoute("/")
  .config({
    mode: "ssr",
  })
  .loader(
    loadPosts
  )
  .page(() => {
    const marker = "PAGE_MARKER";
    return <Card label={marker} />;
  });
`;

test("client stripping keeps the lines of the code it removes", () => {
  const { code } = transformForClient(ROUTE, "/app/page.tsx");

  expect(code).not.toContain("listPosts");
  expect(lineOf(code, "PAGE_MARKER")).toBe(lineOf(ROUTE, "PAGE_MARKER"));
});

test("the HMR wrapper of an imported page component adds no line", () => {
  const source = `import { defineRoute } from "@teyik0/furin";
import { Counter } from "./counter";

export const label = "LABEL_MARKER";
export const route = defineRoute("/page")
  .page(Counter);
`;
  const { code } = transformForClient(source, "/app/page.tsx");

  expect(code).toContain("__furinCreateElement");
  expect(lineOf(code, "LABEL_MARKER")).toBe(lineOf(source, "LABEL_MARKER"));
});

test("isomorphic selection keeps the lines of the implementation it drops", () => {
  const source = `import { createIsomorphicFn } from "@teyik0/furin";

export const read = createIsomorphicFn()
  .server(() => {
    return "server";
  })
  .client(() => "CLIENT_MARKER");
export const after = "AFTER_MARKER";
`;
  const { code } = transformIsomorphicFunctions(source, "/app/read.ts", "client");

  expect(code).not.toContain('"server"');
  expect(lineOf(code, "CLIENT_MARKER")).toBe(lineOf(source, "CLIENT_MARKER"));
  expect(lineOf(code, "AFTER_MARKER")).toBe(lineOf(source, "AFTER_MARKER"));
});

test("kept line breaks never follow a return keyword", async () => {
  const source = `import { createIsomorphicFn } from "@teyik0/furin";

export function read() {
  return createIsomorphicFn()
    .server(() => "server")
    .client(() => "client")();
}
`;
  const { code } = transformIsomorphicFunctions(source, "/app/read.ts", "client");
  const module = (await import(
    `data:text/javascript,${encodeURIComponent(code.replace(/^import .*$/m, ""))}`
  )) as { read: () => string };

  expect(module.read()).toBe("client");
});

test("a split dev page keeps the source lines in its contract and render modules", () => {
  const source = `import { defineRoute } from "@teyik0/furin";
import { Card } from "./card";

export const route = defineRoute("/read")
  .config({ mode: "ssr" })
  .loader(() => {
    throw new Error("LOADER_MARKER");
  })
  .page(() => {
    const marker = "PAGE_MARKER";
    return <Card label={marker} />;
  });
`;
  const split = splitDevPage(source, "/app/page.tsx", "/app/page.tsx?furin-render&t=1");
  if (!split) {
    throw new Error("Expected the page to split");
  }

  expect(lineOf(split.contract, "LOADER_MARKER")).toBe(lineOf(source, "LOADER_MARKER"));
  expect(lineOf(split.render, "PAGE_MARKER")).toBe(lineOf(source, "PAGE_MARKER"));
});
