import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRscGraph } from "../../../src/rsc/build";
import { environmentGuardPlugin } from "../../../src/rsc/build/environment";
import { resolveBuiltCodecPath, resolveConfiguredCodecPath } from "../../../src/rsc/codec";
import { assertCompatibleRscVersions } from "../../../src/rsc/version";

const paths: string[] = [];
const VERSION_MISMATCH_RE = /must match exactly/;

afterEach(() => {
  for (const path of paths.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function buildProtectedImport(graph: "client" | "rsc", specifier: string) {
  const root = mkdtempSync(join(tmpdir(), "furin-rsc-guard-"));
  paths.push(root);
  const entry = join(root, "entry.ts");
  writeFileSync(entry, `import ${JSON.stringify(specifier)};`);
  return Bun.build({
    conditions: graph === "rsc" ? ["react-server"] : undefined,
    entrypoints: [entry],
    outdir: join(root, "out"),
    plugins: [environmentGuardPlugin(graph)],
    target: graph === "client" ? "browser" : "bun",
  });
}

describe("RSC graph environment guards", () => {
  test("emits the Flight codec next to the production server bundle", async () => {
    const root = mkdtempSync(join(tmpdir(), "furin-rsc-build-"));
    paths.push(root);
    const rootEntry = join(root, "root.tsx");
    writeFileSync(rootEntry, "export default function Root() { return null; }");

    await buildRscGraph(
      [{ root: { path: rootEntry, route: {} as never }, routes: [] }],
      root,
      "test-build",
      undefined
    );

    expect(existsSync(join(root, "server-codec.js"))).toBe(true);
    expect(readFileSync(join(root, "server-codec.js"), "utf8")).not.toContain(
      "Flight payload exceeds"
    );
  });

  test("builds the shared Flight drain into the direct react-server graph", async () => {
    const root = mkdtempSync(join(tmpdir(), "furin-rsc-direct-"));
    paths.push(root);
    const result = await Bun.build({
      conditions: ["react-server"],
      entrypoints: [join(import.meta.dir, "../../../src/rsc-server.tsx")],
      outdir: root,
      target: "bun",
    });

    expect(result.success).toBe(true);
    const [output] = result.outputs;
    expect(output).toBeDefined();
    expect(await output?.text()).toContain("Flight payload exceeds");
  });

  test("keeps only the server isomorphic branch in the RSC graph", async () => {
    const root = mkdtempSync(join(tmpdir(), "furin-rsc-isomorphic-"));
    paths.push(root);
    const rootEntry = join(root, "root.tsx");
    writeFileSync(join(root, "server.ts"), 'export const value = "RSC_SERVER_MARKER";');
    writeFileSync(join(root, "client.ts"), 'export const value = "RSC_CLIENT_MARKER";');
    writeFileSync(
      rootEntry,
      `
        import { createIsomorphicFn } from "@teyik0/furin";
        import { value as serverValue } from "./server";
        import { value as clientValue } from "./client";

        export const getValue = createIsomorphicFn()
          .server(() => serverValue)
          .client(() => clientValue);
        export default function Root() { return null; }
      `
    );

    await buildRscGraph(
      [{ root: { path: rootEntry, route: {} as never }, routes: [] }],
      root,
      "test-build",
      undefined
    );
    const output = readdirSync(join(root, "rsc"))
      .filter((file) => file.endsWith(".js"))
      .map((file) => readFileSync(join(root, "rsc", file), "utf8"))
      .join("\n");

    expect(output).toContain("RSC_SERVER_MARKER");
    expect(output).not.toContain("RSC_CLIENT_MARKER");
  });

  test("builds all mounted apps into one RSC graph", async () => {
    const root = mkdtempSync(join(tmpdir(), "furin-rsc-multi-app-"));
    paths.push(root);
    const firstRoot = join(root, "first-root.tsx");
    const secondRoot = join(root, "second-root.tsx");
    writeFileSync(
      firstRoot,
      'export const firstMarker = "FIRST_RSC_APP"; export default function Root() { return null; }'
    );
    writeFileSync(
      secondRoot,
      'export const secondMarker = "SECOND_RSC_APP"; export default function Root() { return null; }'
    );

    await buildRscGraph(
      [
        { root: { path: firstRoot, route: {} as never }, routes: [] },
        { root: { path: secondRoot, route: {} as never }, routes: [] },
      ],
      root,
      "test-build",
      undefined
    );
    const output = readdirSync(join(root, "rsc"))
      .filter((file) => file.endsWith(".js"))
      .map((file) => readFileSync(join(root, "rsc", file), "utf8"))
      .join("\n");

    expect(output).toContain("FIRST_RSC_APP");
    expect(output).toContain("SECOND_RSC_APP");
  });

  test("uses an explicitly configured prebuilt Flight codec", () => {
    const root = mkdtempSync(join(tmpdir(), "furin-rsc-codec-"));
    paths.push(root);
    const codecPath = join(root, "server-codec.js");
    writeFileSync(codecPath, "export const renderFlight = () => null;");

    expect(resolveConfiguredCodecPath(codecPath)).toBe(codecPath);
  });

  test("treats a blank configured Flight codec path as unset", () => {
    expect(resolveConfiguredCodecPath("   ")).toBeUndefined();
  });

  test("resolves the Flight codec next to a compiled executable", () => {
    const moduleDir = mkdtempSync(join(tmpdir(), "furin-rsc-module-"));
    const executableDir = mkdtempSync(join(tmpdir(), "furin-rsc-executable-"));
    paths.push(moduleDir, executableDir);
    const codecPath = join(executableDir, "server-codec.js");
    writeFileSync(codecPath, "export const renderFlight = () => null;");

    expect(resolveBuiltCodecPath(moduleDir, join(executableDir, "server"))).toBe(codecPath);
  });

  test("rejects mismatched React and Flight codec versions", () => {
    expect(() =>
      assertCompatibleRscVersions({
        react: "19.2.7",
        reactDom: "19.2.7",
        reactServerDom: "19.2.6",
      })
    ).toThrow(VERSION_MISMATCH_RE);
  });

  test("rejects insecure React 19.2.0 prerelease patch variants", () => {
    expect(() =>
      assertCompatibleRscVersions({
        react: "19.2.0-canary-1",
        reactDom: "19.2.0-canary-1",
        reactServerDom: "19.2.0-canary-1",
      })
    ).toThrow("supported patched React 19 version");
  });

  test("accepts only patched supported React 19 release lines", () => {
    for (const version of ["19.0.6", "19.0.9", "19.1.7", "19.1.8", "19.2.6", "19.2.7"]) {
      expect(() =>
        assertCompatibleRscVersions({ react: version, reactDom: version, reactServerDom: version })
      ).not.toThrow();
    }
    for (const version of [
      "19.0.5",
      "19.1.6",
      "19.2.5",
      "19.2.6-canary.1",
      "19.3.0",
      "20.0.0",
      "19.2",
    ]) {
      expect(() =>
        assertCompatibleRscVersions({ react: version, reactDom: version, reactServerDom: version })
      ).toThrow("supported patched React 19 version");
    }
  });

  test("rejects server-only modules from the browser graph", async () => {
    await expect(buildProtectedImport("client", "furin/server-only")).rejects.toThrow();
  });

  test("rejects client-only modules from the RSC graph", async () => {
    await expect(buildProtectedImport("rsc", "furin/client-only")).rejects.toThrow();
  });
});
