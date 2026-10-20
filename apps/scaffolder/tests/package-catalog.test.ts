import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { getPackageCatalog, type PackageCatalog } from "../src/package-catalog.ts";

interface WorkspaceManifest {
  catalog: { [name: string]: string };
}

interface CoreManifest {
  peerDependencies: { [name: string]: string };
}

const repoRoot = resolve(import.meta.dir, "../../..");
const RANGE_OPERATOR_RE = /^[\^~]/;

describe("package catalog", () => {
  it("resolves to versions that satisfy Furin's peer dependencies", async () => {
    const workspace: WorkspaceManifest = await Bun.file(resolve(repoRoot, "package.json")).json();
    const core: CoreManifest = await Bun.file(
      resolve(repoRoot, "packages/core/package.json")
    ).json();
    const catalog = getPackageCatalog();
    const shared = Object.keys(core.peerDependencies).filter(
      (name): name is keyof PackageCatalog => name in catalog
    );

    expect(shared).toContain("react");
    for (const name of shared) {
      const peer = core.peerDependencies[name] ?? "";
      const range = peer === "catalog:" ? (workspace.catalog[name] ?? "") : peer;
      const lowest = catalog[name].replace(RANGE_OPERATOR_RE, "");
      expect(Bun.semver.satisfies(lowest, range), `${name}@${catalog[name]} vs ${range}`).toBe(
        true
      );
    }
  });
});
