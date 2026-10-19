import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transformForClient } from "../../../src/plugin/transform-client.ts";
import { transformIsomorphicFunctions } from "../../../src/plugin/transform-isomorphic.ts";
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
