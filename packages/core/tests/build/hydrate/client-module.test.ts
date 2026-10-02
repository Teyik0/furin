import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stripPlugin from "../../../src/plugin";
import { clientModuleKey } from "../../../src/plugin/transform-client-module";
import { isomorphicTransformPlugin } from "../../../src/plugin/transform-isomorphic";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createClientModuleApp(): string {
  const root = mkdtempSync(join(tmpdir(), "furin-client-module-"));
  temporaryDirectories.push(root);
  writeFileSync(join(root, "scene.ts"), 'export const mount = () => "THREE_MARKER";');
  writeFileSync(
    join(root, "canvas.ts"),
    `
      import { clientModule } from "@teyik0/furin/client";
      export const scene = clientModule(() => import("./scene"));
    `
  );
  return root;
}

test("the server build plugin keeps a client-only module out of the server bundle", async () => {
  const root = createClientModuleApp();

  const result = await Bun.build({
    entrypoints: [join(root, "canvas.ts")],
    external: ["@teyik0/furin/client"],
    outdir: join(root, "out"),
    plugins: [isomorphicTransformPlugin("server")],
    target: "bun",
  });

  expect(result.outputs).toHaveLength(1);
  const output = readFileSync(result.outputs[0]?.path ?? "", "utf8");
  expect(output).not.toContain("THREE_MARKER");
  expect(output).toContain("clientModule(");
});

test("the browser strip plugin keeps the loader and tags it with the module key", async () => {
  const root = createClientModuleApp();

  const result = await Bun.build({
    entrypoints: [join(root, "canvas.ts")],
    external: ["@teyik0/furin/client"],
    outdir: join(root, "out"),
    plugins: [stripPlugin],
    splitting: true,
    target: "browser",
  });

  const outputs = result.outputs.map((output) => readFileSync(output.path, "utf8"));
  expect(outputs.some((code) => code.includes(clientModuleKey(join(root, "scene.ts"))))).toBe(true);
  expect(outputs.some((code) => code.includes("THREE_MARKER"))).toBe(true);
});
