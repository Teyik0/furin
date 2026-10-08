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
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyExternalPackages } from "../src/external";

test("external closure rejects unsafe root and manifest names before changing output", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-external-names-"));
  try {
    const output = join(root, "output");
    const fixture = join(root, "node_modules/fixture");
    const wrapper = join(root, "node_modules/wrapper");
    await mkdir(fixture, { recursive: true });
    await mkdir(wrapper, { recursive: true });
    await writeFile(
      join(wrapper, "package.json"),
      JSON.stringify({ dependencies: { fixture: "*" } })
    );
    await mkdir(output, { recursive: true });
    await writeFile(join(root, "package.json"), '{"name":"consumer"}');
    await writeFile(join(output, "sentinel"), "unchanged");
    const invalid = [
      ".",
      "..",
      "@scope/.",
      "@scope/..",
      "@./name",
      "@../name",
      "../escape",
      "a\\b",
    ];
    await Promise.all(
      invalid.map(async (name) => {
        await expect(copyExternalPackages(root, output, [name])).rejects.toThrow("package name");
      })
    );
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of invalid) {
        // biome-ignore lint/performance/noAwaitInLoops: Sequential fixtures exercise each manifest independently.
        await writeFile(
          join(fixture, "package.json"),
          JSON.stringify({ [field]: { [name]: "*" } })
        );
        await expect(copyExternalPackages(root, output, ["wrapper"])).rejects.toThrow(
          "package name"
        );
        expect(await readdir(output)).toEqual(["sentinel"]);
      }
    }
    expect(await readFile(join(output, "sentinel"), "utf8")).toBe("unchanged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    await symlink("asset.txt", join(fixture, "linked.asset"), "file");
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
    await symlink(a, join(root, "node_modules/@fixture/a"), "dir");
    await symlink(b, join(root, "node_modules/b"), "dir");
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

test("external closure materializes a repeated source when its ancestor resolution can terminate", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-external-finite-cycle-"));
  try {
    const packages = [
      ["a1", "a", "1.0.0", "b1", "b"],
      ["b1", "b", "1.0.0", "a2", "a"],
      ["a2", "a", "2.0.0", "c", "c"],
      ["c", "c", "1.0.0", "a1", "a"],
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
            type: "module",
            main: "index.js",
            dependencies: { [dependencyName]: "*" },
          })
        );
        await writeFile(
          join(source, "index.js"),
          `export const version = "${version}"; export const next = () => import("${dependencyName}");`
        );
        await symlink(
          join(root, "store", dependency),
          join(source, "node_modules", dependencyName),
          "dir"
        );
      })
    );
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(join(root, "store/a1"), join(root, "node_modules/a"), "dir");
    const output = join(root, "output");
    await copyExternalPackages(root, output, ["a"]);
    await rm(join(root, "store"), { recursive: true, force: true });
    await rm(join(root, "node_modules"), { recursive: true, force: true });
    await assertMaterialized(output);
    const a1 = await import(join(output, "node_modules/a/index.js"));
    const b1 = await a1.next();
    const a2 = await b1.next();
    const c = await a2.next();
    const repeated = await c.next();
    expect([a1.version, b1.version, a2.version, c.version, repeated.version]).toEqual([
      "1.0.0",
      "1.0.0",
      "2.0.0",
      "1.0.0",
      "1.0.0",
    ]);
    expect(await repeated.next()).toBe(b1);
    expect(
      await Bun.file(
        join(
          output,
          "node_modules/a/node_modules/b/node_modules/a/node_modules/c/node_modules/a/node_modules/b/package.json"
        )
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
          join(source, "node_modules", dependencyName),
          "dir"
        );
      })
    );
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(join(root, "store/a1"), join(root, "node_modules/a"), "dir");
    const output = join(root, "output");
    await expect(copyExternalPackages(root, output, ["a"])).rejects.toThrow(
      'Cannot materialize external dependency cycle for "b": conflicting package versions shadow its ancestor.'
    );
    expect(
      await Bun.file(
        join(
          output,
          "node_modules/a/node_modules/b/node_modules/a/node_modules/b/node_modules/a/node_modules/b/package.json"
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
    await symlink(a, join(root, "node_modules/alias-a"), "dir");
    await symlink(b, join(a, "node_modules/b"), "dir");
    await symlink(a, join(b, "node_modules/a"), "dir");
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
  for (const [link, message, type] of [
    ["../../private", "escapes its package", "file"],
    [".", "directory cycle", "dir"],
    ["node_modules/private-dev", "source node_modules", "dir"],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: Each isolated failure fixture is cleaned up before the next case.
    const root = await mkdtemp(join(tmpdir(), "furin-external-asset-"));
    const asset = join(root, "node_modules/fixture/asset");
    let linked = false;
    try {
      const fixture = join(root, "node_modules/fixture");
      await mkdir(join(fixture, "node_modules/private-dev"), { recursive: true });
      await writeFile(join(fixture, "package.json"), '{"name":"fixture"}');
      await writeFile(join(root, "private"), "must-not-be-copied");
      await symlink(link, asset, type);
      linked = true;
      await expect(copyExternalPackages(root, join(root, "output"), ["fixture"])).rejects.toThrow(
        message
      );
    } finally {
      try {
        if (linked) {
          await unlink(asset);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});
