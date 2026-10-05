import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyExternalPackages } from "../src/external";

async function assertMaterialized(path: string): Promise<void> {
  const stat = await lstat(path);
  expect(stat.isSymbolicLink()).toBe(false);
  if (stat.isDirectory()) {
    await Promise.all((await readdir(path)).map((name) => assertMaterialized(join(path, name))));
  }
}

test("external closure preserves package assets, nested versions and omits dev deps", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-external-"));
  try {
    const fixture = join(root, "node_modules/fixture");
    await mkdir(join(fixture, "node_modules/dep"), { recursive: true });
    await mkdir(join(root, "node_modules/dep"), { recursive: true });
    await writeFile(
      join(fixture, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        dependencies: { dep: "1.0.0" },
        devDependencies: { unused: "*" },
      })
    );
    await writeFile(join(fixture, "asset.txt"), "binary-resource");
    await symlink("asset.txt", join(fixture, "linked.asset"));
    await writeFile(join(fixture, "index.js"), "export { default } from 'dep';");
    await Promise.all(
      (
        [
          [join(fixture, "node_modules/dep"), "1"],
          [join(root, "node_modules/dep"), "2"],
        ] as const
      ).map(async ([folder, version]) => {
        await writeFile(
          join(folder, "package.json"),
          JSON.stringify({
            name: "dep",
            version: `${version}.0.0`,
            main: "index.js",
          })
        );
        await writeFile(join(folder, "index.js"), `export default ${version};`);
      })
    );
    const staging = join(root, "staging");
    await copyExternalPackages(root, staging, ["fixture", "dep"]);
    const output = join(root, "relocated");
    await rename(staging, output);
    await rm(join(root, "node_modules"), { recursive: true, force: true });
    await assertMaterialized(output);
    expect(await readFile(join(output, "node_modules/fixture/asset.txt"), "utf8")).toBe(
      "binary-resource"
    );
    expect(await readFile(join(output, "node_modules/fixture/linked.asset"), "utf8")).toBe(
      "binary-resource"
    );
    const one = await import(join(output, "node_modules/fixture/index.js"));
    const two = await import(join(output, "node_modules/dep/index.js"));
    expect(one.default).toBe(1);
    expect(two.default).toBe(2);
    expect(await Bun.file(join(output, "node_modules/unused/package.json")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external closure resolves scoped peers and cycles without copying source node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-external-cycle-"));
  try {
    const a = join(root, "node_modules/.bun/a/node_modules/@fixture/a");
    const b = join(root, "node_modules/.bun/b/node_modules/b");
    await mkdir(join(a, "node_modules/private-dev"), { recursive: true });
    await mkdir(b, { recursive: true });
    await mkdir(join(root, "node_modules/@fixture"), { recursive: true });
    await symlink(a, join(root, "node_modules/@fixture/a"));
    await symlink(b, join(root, "node_modules/b"));
    await writeFile(
      join(a, "package.json"),
      JSON.stringify({
        name: "@fixture/a",
        main: "index.js",
        dependencies: { b: "*" },
        optionalDependencies: { missing: "*" },
        devDependencies: { "private-dev": "*" },
      })
    );
    await writeFile(join(a, "index.js"), "export { value } from 'b'; export const identity = 'a';");
    await writeFile(join(a, "node_modules/private-dev/secret"), "not-runtime");
    await writeFile(
      join(b, "package.json"),
      JSON.stringify({
        name: "b",
        main: "index.js",
        peerDependencies: { "@fixture/a": "*", absent: "*" },
        peerDependenciesMeta: { absent: { optional: true } },
      })
    );
    await writeFile(
      join(b, "index.js"),
      "import { identity } from '@fixture/a'; export const value = () => identity;"
    );
    const output = join(root, "output");
    await copyExternalPackages(root, output, ["@fixture/a"]);
    await rm(join(root, "node_modules"), { recursive: true, force: true });
    await assertMaterialized(output);
    const imported = await import(join(output, "node_modules/@fixture/a/index.js"));
    expect(imported.value()).toBe("a");
    expect(
      await Bun.file(
        join(output, "node_modules/@fixture/a/node_modules/private-dev/secret")
      ).exists()
    ).toBe(false);
    expect(
      await Bun.file(
        join(output, "node_modules/@fixture/a/node_modules/b/node_modules/@fixture/a/package.json")
      ).exists()
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external closure rejects a cycle whose conflicting versions cannot be materialized", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-external-conflict-"));
  try {
    const packages = [
      ["a1", "a", "1.0.0", "b1", "b"],
      ["b1", "b", "1.0.0", "a2", "a"],
      ["a2", "a", "2.0.0", "b2", "b"],
      ["b2", "b", "2.0.0", "a1", "a"],
    ] as const;
    await Promise.all(
      packages.map(async ([id, name, version, dependency, dependencyName]) => {
        const source = join(root, "store", id);
        await mkdir(join(source, "node_modules"), { recursive: true });
        await writeFile(
          join(source, "package.json"),
          JSON.stringify({
            name,
            version,
            dependencies: { [dependencyName]: "*" },
          })
        );
        await symlink(
          join(root, "store", dependency),
          join(source, "node_modules", dependencyName)
        );
      })
    );
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(join(root, "store/a1"), join(root, "node_modules/a"));
    const output = join(root, "output");
    await expect(copyExternalPackages(root, output, ["a"])).rejects.toThrow(
      'Cannot materialize external dependency cycle for "a": conflicting package versions shadow its ancestor.'
    );
    expect(
      await Bun.file(
        join(
          output,
          "node_modules/a/node_modules/b/node_modules/a/node_modules/b/node_modules/a/package.json"
        )
      ).exists()
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external closure materializes an alias cycle that needs the same source under a different name", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-external-alias-"));
  try {
    const a = join(root, "store/a");
    const b = join(root, "store/b");
    await mkdir(join(a, "node_modules"), { recursive: true });
    await mkdir(join(b, "node_modules"), { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(a, join(root, "node_modules/alias-a"));
    await symlink(b, join(a, "node_modules/b"));
    await symlink(a, join(b, "node_modules/a"));
    await writeFile(
      join(a, "package.json"),
      JSON.stringify({
        name: "a",
        main: "index.js",
        dependencies: { b: "*" },
      })
    );
    await writeFile(
      join(b, "package.json"),
      JSON.stringify({
        name: "b",
        main: "index.js",
        dependencies: { a: "*" },
      })
    );
    await writeFile(join(a, "index.js"), "export const identity = 'a'; export { value } from 'b';");
    await writeFile(
      join(b, "index.js"),
      "import { identity } from 'a'; export const value = () => identity;"
    );
    const output = join(root, "output");
    await copyExternalPackages(root, output, ["alias-a"]);
    await rm(join(root, "store"), { recursive: true, force: true });
    await rm(join(root, "node_modules"), { recursive: true, force: true });
    await assertMaterialized(output);
    const imported = await import(join(output, "node_modules/alias-a/index.js"));
    expect(imported.value()).toBe("a");
    expect(
      await Bun.file(
        join(output, "node_modules/alias-a/node_modules/b/node_modules/a/package.json")
      ).exists()
    ).toBe(true);
    expect(
      await Bun.file(
        join(
          output,
          "node_modules/alias-a/node_modules/b/node_modules/a/node_modules/b/package.json"
        )
      ).exists()
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external assets cannot escape their package, copy source dependencies or create cycles", async () => {
  for (const [link, message] of [
    ["../../private", "escapes its package"],
    [".", "directory cycle"],
    ["node_modules/private-dev", "source node_modules"],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: Each isolated failure fixture is cleaned up before the next case.
    const root = await mkdtemp(join(tmpdir(), "furin-external-asset-"));
    try {
      const fixture = join(root, "node_modules/fixture");
      await mkdir(join(fixture, "node_modules/private-dev"), { recursive: true });
      await writeFile(join(fixture, "package.json"), '{"name":"fixture"}');
      await writeFile(join(root, "private"), "must-not-be-copied");
      await symlink(link, join(fixture, "asset"));
      await expect(copyExternalPackages(root, join(root, "output"), ["fixture"])).rejects.toThrow(
        message
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
