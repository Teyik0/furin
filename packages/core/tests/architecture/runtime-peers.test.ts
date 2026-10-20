import { expect, test } from "bun:test";
import { join } from "node:path";

interface CoreManifest {
  dependencies: { [name: string]: string };
  peerDependencies: { [name: string]: string };
  peerDependenciesMeta: { [name: string]: { optional?: boolean } | undefined };
}

const manifest: CoreManifest = await Bun.file(join(import.meta.dir, "../../package.json")).json();

test("Furin declares Elysia's exact-mirror as a required peer instead of a direct dependency", () => {
  expect(manifest.dependencies["exact-mirror"]).toBeUndefined();
  expect(manifest.peerDependencies["exact-mirror"]).toBe(">=1.2.6");
  expect(manifest.peerDependenciesMeta["exact-mirror"]?.optional).not.toBe(true);
});

test("Furin declares @types/bun as an optional peer because published types import from bun", () => {
  expect(manifest.peerDependencies["@types/bun"]).toBeDefined();
  expect(manifest.peerDependenciesMeta["@types/bun"]?.optional).toBe(true);
});
