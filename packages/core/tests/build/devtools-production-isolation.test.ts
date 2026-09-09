import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createTmpApp, type TmpApp } from "../support/app-fixtures.ts";
import { runCli } from "../support/process.ts";

const DEVTOOLS_MARKERS = [
  "/_furin/devtools",
  "furin-devtools",
  "x-furin-devtools-operation-id",
  "loader.finished",
  "cache.invalidated",
  "payload.serialized",
  "FurinDevtoolsElement",
  "Runtime overview",
] as const;

const tmpApps: TmpApp[] = [];

function filesBelow(path: string): string[] {
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

afterEach(() => {
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

describe.serial("production DevTools isolation", () => {
  test(
    "the production server bundle contains no DevTools code",
    async () => {
      const app = createTmpApp("cli-app-ssr");
      tmpApps.push(app);

      const result = await runCli(["build"], { cwd: app.path });

      expect(result.exitCode).toBe(0);
      const bundle = readFileSync(join(app.path, ".furin/build/bun/server.js"), "utf8");
      const presentMarkers = DEVTOOLS_MARKERS.filter((marker) => bundle.includes(marker));

      expect(presentMarkers).toEqual([]);

      const clientDir = join(app.path, ".furin/build/bun/client");
      const clientArtifacts = filesBelow(clientDir);
      expect(clientArtifacts.some((path) => path.endsWith("/devtools/client.js"))).toBe(false);
      for (const artifact of clientArtifacts) {
        const contents = readFileSync(artifact, "utf8");
        expect(DEVTOOLS_MARKERS.filter((marker) => contents.includes(marker))).toEqual([]);
      }
    },
    { timeout: 30_000 }
  );

  test(
    "the compiled production binary contains no DevTools code",
    async () => {
      const app = createTmpApp("cli-app-ssr");
      tmpApps.push(app);

      const result = await runCli(["build", "--compile", "embed"], { cwd: app.path });

      expect(result.exitCode).toBe(0);
      const binaryPath = ["server", "server.exe"]
        .map((name) => join(app.path, ".furin/build/bun", name))
        .find(existsSync);
      expect(binaryPath).toBeDefined();
      const binary = readFileSync(binaryPath as string).toString("latin1");
      const presentMarkers = DEVTOOLS_MARKERS.filter((marker) => binary.includes(marker));

      expect(presentMarkers).toEqual([]);
    },
    { timeout: 30_000 }
  );
});
