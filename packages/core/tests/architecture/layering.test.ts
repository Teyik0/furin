import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Glob } from "bun";

/**
 * Mechanically enforces the `server -> client -> shared` dependency DAG that the
 * directory restructure established (commits e32c38e, 6e4008c). Without a guard,
 * a future edit could reintroduce a leaky boundary — e.g. `client/` importing a
 * server-only module would silently pull server code (and its `elysia` runtime)
 * into the browser bundle, or `shared/` importing `client/` would break the
 * isomorphic guarantee that shared modules run on both server and client.
 *
 * Detection uses `Bun.Transpiler.scanImports`, a real parser, so it (a) never
 * false-positives on import-looking strings inside comments or error messages,
 * and (b) reports only RUNTIME imports — `import type` is elided. That is the
 * right granularity: type-only edges are erased at build time and cannot leak
 * code into a bundle, whereas a value/dynamic import is a real dependency.
 *
 * `client.ts` (the public contracts barrel: rendering metadata and defer,
 * …) is browser-safe — it pulls in only `shared/` and `elysia`/`evlog` *types*
 * — so both `shared/` and `client/` may depend on it.
 */

const SRC = resolve(import.meta.dir, "../../src");

const tsxTranspiler = new Bun.Transpiler({ loader: "tsx" });
const tsTranspiler = new Bun.Transpiler({ loader: "ts" });

function runtimeImports(file: string, code: string): string[] {
  const transpiler = file.endsWith(".tsx") ? tsxTranspiler : tsTranspiler;
  return transpiler.scanImports(code).map((entry) => entry.path);
}

// Resolve a relative specifier to the real source file, mirroring Bun's
// resolution order (a sibling `.ts`/`.tsx` file wins over a same-named
// directory), then report the top-level location within `src/`.
function locationOf(fromDir: string, specifier: string): string {
  const base = resolve(fromDir, specifier);
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    base,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate)) ?? base;
  const rel = relative(SRC, resolved);
  if (rel.startsWith("..")) {
    return "<outside-src>";
  }
  return rel.split(sep)[0] ?? rel;
}

const FORBIDDEN_TARGETS: Record<"shared" | "client", Set<string>> = {
  // client may use shared + the contracts barrel, but never server runtime.
  client: new Set(["server", "furin.ts", "config.ts", "build", "plugin", "cli", "adapter"]),
  // shared is the isomorphic leaf: no client- or server-only code, no tooling.
  shared: new Set([
    "client",
    "server",
    "furin.ts",
    "config.ts",
    "build",
    "plugin",
    "cli",
    "adapter",
  ]),
};

function collectViolations(layer: "shared" | "client"): string[] {
  const violations: string[] = [];
  const glob = new Glob(`${layer}/**/*.{ts,tsx}`);
  for (const rel of glob.scanSync({ cwd: SRC })) {
    const file = resolve(SRC, rel);
    const code = readFileSync(file, "utf8");
    for (const specifier of runtimeImports(file, code)) {
      if (!specifier.startsWith(".")) {
        continue; // external / bare specifier
      }
      const target = locationOf(dirname(file), specifier);
      if (FORBIDDEN_TARGETS[layer].has(target)) {
        violations.push(`src/${rel} imports "${specifier}" -> src/${target}`);
      }
    }
  }
  return violations;
}

describe("architecture: server -> client -> shared layering", () => {
  test("shared/ pulls in no client- or server-only runtime code", () => {
    expect(collectViolations("shared")).toEqual([]);
  });

  test("client/ pulls in no server-only runtime code", () => {
    expect(collectViolations("client")).toEqual([]);
  });
});
