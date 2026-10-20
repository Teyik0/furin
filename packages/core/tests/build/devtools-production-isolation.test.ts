import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createTmpApp, type TmpApp } from "../support/app-fixtures.ts";
import { runCli } from "../support/process.ts";

const DEVTOOLS_MARKERS = [
  "/_furin/dev/overlay",
  "/_furin/devtools",
  "Development source transform failed",
  "Furin development error",
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
  // Both Vercel assertions inspect the same build output, so build it once.
  describe.serial("Vercel build", () => {
    let app: TmpApp;
    let exitCode: number;

    beforeAll(async () => {
      app = createTmpApp("cli-app-ssr");
      ({ exitCode } = await runCli(["build", "--target", "vercel", "--analyze"], {
        cwd: app.path,
      }));
    }, 30_000);

    afterAll(() => app?.cleanup());

    test("a Vercel app without sync keeps WebSocket and sync code out of its handler", () => {
      expect(exitCode).toBe(0);
      const handler = readFileSync(
        join(app.path, ".vercel/output/functions/__server.func/handler.js"),
        "utf8"
      );
      expect(handler).not.toContain("FURIN_BROWSER_EVENTS_CAPACITY");
      expect(handler).not.toContain("FURIN_INVALID_SYNC_CURSOR");
    });

    test("the Vercel server bundle excludes development route state", () => {
      expect(exitCode).toBe(0);
      const metafile = JSON.parse(
        readFileSync(join(app.path, ".furin/build/analysis/vercel-server.json"), "utf8")
      ) as { inputs: object };
      expect(
        Object.keys(metafile.inputs).some((path) => path.endsWith("/server/dev/graph.ts"))
      ).toBe(false);
    });
  });

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
