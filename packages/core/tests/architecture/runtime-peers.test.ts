import { expect, test } from "bun:test";
import { join } from "node:path";

interface CoreManifest {
  dependencies: { [name: string]: string };
  peerDependencies: { [name: string]: string };
  peerDependenciesMeta: { [name: string]: { optional?: boolean } | undefined };
}

const manifest: CoreManifest = await Bun.file(join(import.meta.dir, "../../package.json")).json();

test.each(["exact-mirror", "typebox"])(
  "Furin declares Elysia's %s as a required peer instead of a direct dependency",
  (name) => {
    expect(manifest.dependencies[name]).toBeUndefined();
    expect(manifest.peerDependencies[name]).toBeDefined();
    expect(manifest.peerDependenciesMeta[name]?.optional).not.toBe(true);
  }
);

test("Furin declares @types/bun as an optional peer because published types import from bun", () => {
  expect(manifest.peerDependencies["@types/bun"]).toBeDefined();
  expect(manifest.peerDependenciesMeta["@types/bun"]?.optional).toBe(true);
});

// Peers are the public contract; the workspace catalog only pins the monorepo.
// Elysia 2.0.0-rc.3 requires typebox >=1.3.35 and exact-mirror >=1.2.7.
test.each([
  ["elysia", "2.0.0-rc.3"],
  ["elysia", "2.0.0"],
  ["@elysia/eden", "2.0.0"],
  ["typebox", "1.3.35"],
  ["exact-mirror", "1.2.7"],
])("Furin accepts an application that installs %s@%s", (name, version) => {
  const range = manifest.peerDependencies[name] ?? manifest.dependencies[name] ?? "";
  // Bun.semver reads protocols such as "catalog:" as "*"; require a literal range.
  expect(range).not.toContain(":");
  expect(Bun.semver.satisfies(version, range), `${name}@${version} vs "${range}"`).toBe(true);
});
