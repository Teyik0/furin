import { expect, test } from "bun:test";
import { join } from "node:path";

test("Furin declares TypeBox as a required peer instead of a direct dependency", async () => {
  const manifest = (await Bun.file(join(import.meta.dir, "../../package.json")).json()) as {
    dependencies: { typebox?: string };
    peerDependencies: { typebox?: string };
    peerDependenciesMeta?: { typebox?: { optional?: boolean } };
  };

  expect(manifest.dependencies.typebox).toBeUndefined();
  expect(manifest.peerDependencies.typebox).toBe("catalog:");
  expect(manifest.peerDependenciesMeta?.typebox?.optional).not.toBe(true);
});
