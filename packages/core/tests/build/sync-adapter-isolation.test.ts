import { beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { treaty } from "@elysia/eden";
import { Elysia } from "elysia";
import { websocket } from "elysia/websocket";
import { assertDistFresh } from "../support/dist.ts";
import { runProcess } from "../support/process.ts";

const fixtures = new URL("../fixtures/sync-bundles/", import.meta.url);
const postgresMarker = "pg_advisory_xact_lock";
const postgresNotifierMarker = "furin_sync_";
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
    entrypoints: [fileURLToPath(new URL(`${name}.ts`, fixtures))],
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
  // These tests inspect the published dist/ output; refuse to run on a stale build.
  beforeAll(() => assertDistFresh("server/sync/index.js"));

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

  test("bundles the autonomous client without React or server adapters", async () => {
    const output = await bundle("standalone", "browser");
    expect(output).not.toContain('from "react"');
    expect(output).not.toContain("react/jsx-runtime");
    expect(output).not.toContain(postgresMarker);
    expect(output).not.toContain(redisMarker);
    expect(output).not.toContain(sqliteMarker);
  });

  test("local client failures are recognized by the public standalone error class", async () => {
    const { createLocalSyncClient } = await import("../../dist/server/sync/index.js");
    const { furinSync, SyncClientError } = await import("../../dist/sync-client.js");
    const { sqliteSyncAdapter, migrateSqliteSync } = await import("../../dist/server/sync/sqlite/index.js");
    const { Database } = await import("bun:sqlite");
    const database = new Database(":memory:");
    migrateSqliteSync(database);
    const sync = { adapter: sqliteSyncAdapter({ database, namespace: "local-error" }), principal: () => "" };
    const app = new Elysia().get("/state", () => 0).get("/_furin/sync/changes", ({ status }) => status(401));
    const api = treaty(app).use(furinSync);
    const client = createLocalSyncClient({ app, sync });
    const denied = Promise.withResolvers<unknown>();
    try {
      client.subscribeConnection(({ error }) => { if (error) { denied.resolve(error); } });
      client.subscribe(api.state.get.live(), () => undefined);
      expect(await denied.promise).toBeInstanceOf(SyncClientError);
    } finally {
      client.close();
      database.close();
    }
  });

  test("preserves thrown Eden errors from live objects created by the other published entrypoint", async () => {
    const { furinSync } = await import("../../dist/client.js");
    const { createSyncClient } = await import("../../dist/sync-client.js");
    const app = new Elysia()
      .use(websocket())
      .get("/failure", ({ status }) => status(409, { code: "LOCKED" as const }))
      .get("/_furin/sync/changes", { changes: [], cursor: "0", hasMore: false, reset: false })
      .ws("/_furin/events", { open: (socket) => {
        socket.send(JSON.stringify({ version: 1, channel: "sync", data: { cursor: "0" } }));
      } })
      .listen({ port: 0, hostname: "127.0.0.1" });
    const url = app.server?.url.origin;
    if (!url) { throw new Error("Expected a listening server"); }
    const api = treaty<typeof app>(url, { throwHttpError: true }).use(furinSync);
    const client = createSyncClient({ url });
    const received = Promise.withResolvers<unknown>();
    try {
      client.subscribe(api.failure.get.live(), ({ error }) => {
        if (error) { received.resolve(error); }
      });
      expect(await received.promise).toMatchObject({ status: 409, value: { code: "LOCKED" } });
    } finally {
      client.close();
      await app.stop(true);
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
    expect(postgres).toContain(postgresNotifierMarker);
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

  test("loads ORM adapters only through their dedicated entrypoints", async () => {
    const [drizzle, prisma] = await Promise.all([bundle("drizzle", "bun"), bundle("prisma", "bun")]);
    expect(drizzle).toContain(sqliteMarker);
    expect(drizzle).toContain(postgresMarker);
    expect(prisma).toContain(postgresMarker);
    expect(prisma).not.toContain(sqliteMarker);
    expect(prisma).not.toContain("@prisma/client/runtime");
    expect(drizzle).not.toContain(redisMarker);
    expect(prisma).not.toContain(redisMarker);
  });

  test("does not introduce legacy adapter dependencies through the core manifest", async () => {
    const core = await manifest("../../package.json");
    expect(dependencyNames(core)).not.toContain("@teyik0/furin-sync-postgres");
    expect(dependencyNames(core)).not.toContain("@teyik0/furin-sync-redis");
    expect(dependencyNames(core)).not.toContain("@teyik0/furin-sync-sqlite");
  });

  test("loads the published client without requiring consumers to install Eden", async () => {
    const root = resolve(import.meta.dir, "../../../..");
    const directory = mkdtempSync(join(tmpdir(), "furin-client-consumer-"));
    try {
      const archive = await pack(join(root, "packages/core"), directory);
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ dependencies: { "@teyik0/furin": archive }, private: true })
      );
      const install = await runProcess(["bun", "install", "--production", "--ignore-scripts"], {
        cwd: directory,
        // A cold install of the packed tarball can exceed 25 s on Windows runners.
        timeoutMs: 60_000,
      });
      expect(install.exitCode).toBe(0);
      const client = await runProcess(
        [
          "bun",
          "-e",
          'import { defineRoute, defer, furinSync } from "@teyik0/furin/client"; if (typeof furinSync !== "object" || ![defineRoute, defer].every(value => typeof value === "function")) throw new Error("Missing client export");',
        ],
        { cwd: directory, timeoutMs: 25_000 }
      );
      expect(client.stderr).toBe("");
      expect(client.exitCode).toBe(0);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }, 120_000);

  test("bundles isolated subpaths from the packed core package", async () => {
    const root = resolve(import.meta.dir, "../../../..");
    const temporaryRoot = mkdtempSync(join(tmpdir(), "furin-sync-packages-"));
    const packed = join(temporaryRoot, "packed");
    mkdirSync(packed);
    try {
      const core = await pack(join(root, "packages/core"), packed);

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
          entry: 'import { postgresSyncAdapter, postgresSyncNotifier } from "@teyik0/furin/sync/postgres"; console.log(postgresSyncAdapter, postgresSyncNotifier);',
          markers: [postgresMarker, postgresNotifierMarker],
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
        const fixture = await installFixture(join(temporaryRoot, `consumer-${index}`), core);
        writeFileSync(join(fixture, "entry.ts"), scenario.entry);
        const result = await Bun.build({
          entrypoints: [join(fixture, "entry.ts")],
          external: [
            "@elysia/static",
            "@jridgewell/trace-mapping",
            "@yuku-toolchain/types",
            "elysia",
            "evlog",
            "evlog/*",
            "magic-string",
            "react",
            "react-dom",
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

async function pack(packageDirectory: string, destination: string): Promise<string> {
  const before = new Set(readdirSync(destination));
  const result = await runProcess(["bun", "pm", "pack", "--destination", destination], {
    cwd: packageDirectory,
    timeoutMs: 25_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr);
  }
  const archive = readdirSync(destination).find((entry) => !before.has(entry));
  if (archive === undefined) {
    throw new Error(`No package archive created for ${packageDirectory}`);
  }
  return join(destination, archive);
}

async function installFixture(directory: string, core: string): Promise<string> {
  mkdirSync(directory, { recursive: true });
  await installPackedPackage(directory, "@teyik0/furin", core);
  return directory;
}

async function installPackedPackage(
  directory: string,
  name: string,
  archive: string
): Promise<void> {
  const destination = join(directory, "node_modules", ...name.split("/"));
  mkdirSync(destination, { recursive: true });
  const result = await runProcess(
    ["tar", "-xzf", archive, "--strip-components=1", "-C", destination],
    { cwd: directory, timeoutMs: 25_000 }
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr);
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
