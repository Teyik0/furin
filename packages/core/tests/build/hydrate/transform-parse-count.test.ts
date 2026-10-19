import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transformForClient } from "../../../src/plugin/transform-client.ts";
import { splitDevPage } from "../../../src/plugin/transform-dev-page.ts";
import { transformIsomorphicFunctions } from "../../../src/plugin/transform-isomorphic.ts";
import { discoverClientBoundaries } from "../../../src/rsc/build/discover.ts";
import * as parser from "../../../src/shared/parser.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function parseCount(transform: () => void): number {
  const parse = spyOn(parser, "parseSource");
  try {
    transform();
    return parse.mock.calls.length;
  } finally {
    parse.mockRestore();
  }
}

const ROUTE = `import { defineRoute } from "@teyik0/furin";
import { db } from "./db";

const loadPosts = () => db.posts();

export const route = defineRoute()
  .loader(loadPosts)
  .page(() => null);
`;

const ISOMORPHIC = `import { createIsomorphicFn } from "@teyik0/furin";
import { readSecret } from "./server-secret";

const factory = createIsomorphicFn;
export const getValue = factory()
  .server(() => readSecret())
  .client(() => createIsomorphicFn().server(() => "inner-server").client(() => "inner-client")());
`;

function clientModuleRoute(): string {
  const root = mkdtempSync(join(tmpdir(), "furin-parse-count-"));
  temporaryDirectories.push(root);
  writeFileSync(join(root, "scene.ts"), "export const mount = () => null;");
  const filename = join(root, "page.tsx");
  writeFileSync(
    filename,
    `import { clientModule } from "@teyik0/furin/client";
import { createIsomorphicFn, defineRoute } from "@teyik0/furin";
import { readSecret } from "./server-secret";

const scene = clientModule(() => import("./scene"));
const secret = createIsomorphicFn().server(() => readSecret()).client(() => null);

export const route = defineRoute()
  .loader(() => secret())
  .page(() => scene);
`
  );
  return filename;
}

test("a route module is parsed once for the client", () => {
  expect(parseCount(() => transformForClient(ROUTE, "page.tsx"))).toBe(1);
});

test("a module with nested isomorphic functions and factory aliases is parsed once", () => {
  for (const environment of ["client", "server"] as const) {
    expect(
      parseCount(() => transformIsomorphicFunctions(ISOMORPHIC, "shared.ts", environment))
    ).toBe(1);
  }
});

test("a route module using clientModule and createIsomorphicFn is parsed once for the client", () => {
  const filename = clientModuleRoute();
  const source = readFileSync(filename, "utf8");
  expect(parseCount(() => transformForClient(source, filename))).toBe(1);
});

const SPLIT_PAGE = `import { defineRoute } from "@teyik0/furin";
import "./startup";
import { Heavy } from "./heavy";

export const route = defineRoute()
  .config({ mode: "ssr" })
  .page(() => <Heavy />);
`;

test("a dev page split into its contract and render modules is parsed once", () => {
  let split: ReturnType<typeof splitDevPage>;
  expect(
    parseCount(() => {
      split = splitDevPage(SPLIT_PAGE, "/app/page.tsx", "/app/page.tsx?furin-render&t=1");
    })
  ).toBe(1);
  expect(split?.contract).not.toContain('"./heavy"');
});

test("client boundary discovery parses a route entry once for its view stripping", async () => {
  const root = mkdtempSync(join(tmpdir(), "furin-parse-count-"));
  temporaryDirectories.push(root);
  const filename = join(realpathSync(root), "page.tsx");
  writeFileSync(
    filename,
    `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().config({ mode: "ssr" }).page(() => null);
`
  );
  const parse = spyOn(parser, "parseSource");
  try {
    await discoverClientBoundaries([filename], undefined);
    // View stripping, then the isomorphic transform of its output.
    expect(parse.mock.calls.length).toBe(2);
  } finally {
    parse.mockRestore();
  }
});
