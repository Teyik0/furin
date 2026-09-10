import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixtures = new URL("../fixtures/sync-bundles/", import.meta.url);
const postgresMarker = "pg_advisory_xact_lock";
const redisMarker = "redis.call";
const redisNotifierMarker = ":notify";
const sqliteMarker = "furin_sync_mutations";
const migrationMarker = "CREATE SCHEMA IF NOT EXISTS furin_sync";

interface PackageManifest {
  dependencies?: object;
  peerDependencies?: object;
}

async function bundle(name: string, target: "browser" | "bun"): Promise<string> {
  const result = await Bun.build({
    entrypoints: [new URL(`${name}.ts`, fixtures).pathname],
    packages: "bundle",
    root: resolve(import.meta.dir, "../.."),
    target,
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `Could not bundle ${name} fixture`);
  }
  const output = result.outputs[0];
  if (!output) {
    throw new Error(`No output emitted for ${name} fixture`);
  }
  return output.text();
}

async function manifest(path: string): Promise<PackageManifest> {
  return (await Bun.file(new URL(path, import.meta.url)).json()) as PackageManifest;
}

function dependencyNames(manifestValue: PackageManifest): string[] {
  return [
    ...Object.keys(manifestValue.dependencies ?? {}),
    ...Object.keys(manifestValue.peerDependencies ?? {}),
  ];
}

describe("sync adapter bundle isolation", () => {
  test("loads the built sync entrypoint without exposing test internals", async () => {
    const sync = await import("../../dist/server/sync/index.js");
    expect(sync.furinSync).toBeFunction();
    expect("MemorySyncAdapter" in sync).toBe(false);
    expect("MemorySyncNotifier" in sync).toBe(false);
    expect("__resetSyncState" in sync).toBe(false);
  });

  test("keeps core and browser bundles free of optional backend code", async () => {
    const core = await bundle("core", "bun");
    const browser = await bundle("browser", "browser");
    for (const output of [core, browser]) {
      expect(output).not.toContain(postgresMarker);
      expect(output).not.toContain(redisMarker);
      expect(output).not.toContain(sqliteMarker);
      expect(output).not.toContain(migrationMarker);
    }
  });

  test("bundles PostgreSQL, Redis, and SQLite independently", async () => {
    const [postgres, redis, sqlite, hybrid] = await Promise.all([
      bundle("postgres", "bun"),
      bundle("redis", "bun"),
      bundle("sqlite", "bun"),
      bundle("hybrid", "bun"),
    ]);
    expect(postgres).toContain(postgresMarker);
    expect(postgres).not.toContain(redisMarker);
    expect(postgres).not.toContain(sqliteMarker);
    expect(redis).toContain(redisMarker);
    expect(redis).not.toContain(postgresMarker);
    expect(redis).not.toContain(sqliteMarker);
    expect(sqlite).toContain(sqliteMarker);
    expect(sqlite).not.toContain(postgresMarker);
    expect(sqlite).not.toContain(redisMarker);
    expect(hybrid).toContain(postgresMarker);
    expect(hybrid).toContain(redisNotifierMarker);
    expect(hybrid).not.toContain(redisMarker);
    expect(hybrid).not.toContain(sqliteMarker);
  });

  test("does not introduce legacy adapter dependencies through the core manifest", async () => {
    const core = await manifest("../../package.json");
    expect(dependencyNames(core)).not.toContain("@teyik0/furin-sync-postgres");
    expect(dependencyNames(core)).not.toContain("@teyik0/furin-sync-redis");
    expect(dependencyNames(core)).not.toContain("@teyik0/furin-sync-sqlite");
  });

  test("bundles isolated subpaths from the packed core package", async () => {
    const root = resolve(import.meta.dir, "../../../..");
    const temporaryRoot = mkdtempSync(join(tmpdir(), "furin-sync-packages-"));
    const packed = join(temporaryRoot, "packed");
    mkdirSync(packed);
    try {
      const core = pack(join(root, "packages/core"), packed);

      const scenarios: Array<{
        absent: string[];
        entry: string;
        markers: string[];
      }> = [
        {
          absent: [postgresMarker, redisMarker, sqliteMarker, migrationMarker],
          entry: 'import { furinSync } from "@teyik0/furin/sync"; console.log(furinSync);',
          markers: [],
        },
        {
          absent: [redisMarker, sqliteMarker],
          entry: 'import { postgresSyncAdapter } from "@teyik0/furin/sync/postgres"; console.log(postgresSyncAdapter);',
          markers: [postgresMarker],
        },
        {
          absent: [postgresMarker, sqliteMarker],
          entry: 'import { redisSyncAdapter } from "@teyik0/furin/sync/redis"; console.log(redisSyncAdapter);',
          markers: [redisMarker],
        },
        {
          absent: [redisMarker, sqliteMarker],
          entry: 'import { postgresSyncAdapter } from "@teyik0/furin/sync/postgres"; import { RedisSyncNotifier } from "@teyik0/furin/sync/redis"; console.log(postgresSyncAdapter, RedisSyncNotifier);',
          markers: [postgresMarker, redisNotifierMarker],
        },
        {
          absent: [postgresMarker, redisMarker],
          entry: 'import { sqliteSyncAdapter } from "@teyik0/furin/sync/sqlite"; console.log(sqliteSyncAdapter);',
          markers: [sqliteMarker],
        },
      ];

      for (const [index, scenario] of scenarios.entries()) {
        const fixture = installFixture(join(temporaryRoot, `consumer-${index}`), core);
        writeFileSync(join(fixture, "entry.ts"), scenario.entry);
        const result = await Bun.build({
          entrypoints: [join(fixture, "entry.ts")],
          external: [
            "@elysiajs/static",
            "@yuku-toolchain/types",
            "elysia",
            "evlog",
            "evlog/*",
            "magic-string",
            "react",
            "react-dom/*",
            "react-server-dom-webpack",
            "seroval",
            "yuku-parser",
          ],
          packages: "bundle",
          target: "bun",
        });
        expect(result.success).toBe(true);
        const output = await result.outputs[0]?.text();
        if (output === undefined) {
          throw new Error(`No bundle emitted for packed scenario ${index}`);
        }
        for (const marker of scenario.markers) {
          expect(output).toContain(marker);
        }
        for (const marker of scenario.absent) {
          expect(output).not.toContain(marker);
        }
        expect(canResolvePackage(fixture, "@teyik0/furin/sync/postgres")).toBe(true);
        expect(canResolvePackage(fixture, "@teyik0/furin/sync/redis")).toBe(true);
        expect(canResolvePackage(fixture, "@teyik0/furin/sync/sqlite")).toBe(true);
        expect(canResolvePackage(fixture, "@teyik0/furin/sync/postgres/migration.sql")).toBe(true);
        expect(canResolvePackage(fixture, "@teyik0/furin/sync/sqlite/migration.sql")).toBe(true);
      }
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  }, 30_000);
});

function pack(packageDirectory: string, destination: string): string {
  const before = new Set(readdirSync(destination));
  const result = Bun.spawnSync({
    cmd: ["bun", "pm", "pack", "--destination", destination],
    cwd: packageDirectory,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  const archive = readdirSync(destination).find((entry) => !before.has(entry));
  if (archive === undefined) {
    throw new Error(`No package archive created for ${packageDirectory}`);
  }
  return join(destination, archive);
}

function installFixture(directory: string, core: string): string {
  mkdirSync(directory, { recursive: true });
  installPackedPackage(directory, "@teyik0/furin", core);
  return directory;
}

function installPackedPackage(directory: string, name: string, archive: string): void {
  const destination = join(directory, "node_modules", ...name.split("/"));
  mkdirSync(destination, { recursive: true });
  const result = Bun.spawnSync({
    cmd: ["tar", "-xzf", archive, "--strip-components=1", "-C", destination],
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
}

function canResolvePackage(directory: string, specifier: string): boolean {
  try {
    Bun.resolveSync(specifier, directory);
    return true;
  } catch {
    return false;
  }
}
