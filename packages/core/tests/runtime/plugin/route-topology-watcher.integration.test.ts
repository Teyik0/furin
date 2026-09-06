import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDevRouteTopologyWatcher, routeSourcePaths } from "../../../src/plugin/routes.ts";

async function waitForCount(readCount: () => number, expected: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (readCount() < expected) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${expected} topology changes`);
    }
    // biome-ignore lint/performance/noAwaitInLoops: bounded polling waits for a native fs event
    await Bun.sleep(10);
  }
}

test("the dev topology watcher reloads only when the route set changes", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "furin-route-watch-"));
  const pagesDir = join(projectRoot, "src/pages");
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(join(pagesDir, "index.ts"), "export const route = 1;\n");

  const topologies: string[][] = [];
  let touchedRouteFiles = 0;
  const instance = { pagesDir, prefix: "" };
  const watcher = registerDevRouteTopologyWatcher({
    instance,
    onRouteFilesTouched: () => {
      touchedRouteFiles += 1;
    },
    onTopologyChange: () => {
      const paths = routeSourcePaths(instance).map((path) => path.replace(`${pagesDir}/`, ""));
      topologies.push(paths);
    },
    pollIntervalMs: 20,
  });

  try {
    writeFileSync(join(pagesDir, "index.ts"), "export const route = 2;\n");
    await waitForCount(() => touchedRouteFiles, 1);
    expect(topologies).toHaveLength(0);

    await Bun.sleep(80);
    expect(touchedRouteFiles).toBe(1);

    const nestedDir = join(pagesDir, "boards");
    mkdirSync(nestedDir);
    writeFileSync(join(nestedDir, "[id].ts"), "export const route = 1;\n");
    await waitForCount(() => topologies.length, 1);

    expect(topologies[0]).toContain("boards/[id].ts");
    await Bun.sleep(80);
    expect(touchedRouteFiles).toBe(1);

    rmSync(join(nestedDir, "[id].ts"));
    await waitForCount(() => topologies.length, 2);
    expect(topologies[1]).toEqual(["index.ts"]);
  } finally {
    watcher.close();
    rmSync(projectRoot, { force: true, recursive: true });
  }
});

test("the dev topology watcher observes transitive route dependencies", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "furin-route-dependency-watch-"));
  const pagesDir = join(projectRoot, "src/pages");
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(join(pagesDir, "_helper.ts"), 'export const value = "one";\n');
  writeFileSync(
    join(pagesDir, "index.ts"),
    'import { value } from "./_helper.ts";\nexport const route = value;\n'
  );

  let touchedRouteFiles = 0;
  const watcher = registerDevRouteTopologyWatcher({
    instance: { pagesDir, prefix: "" },
    onRouteFilesTouched: () => {
      touchedRouteFiles += 1;
    },
    onTopologyChange: () => undefined,
    pollIntervalMs: 20,
  });

  try {
    const helperPath = join(pagesDir, "_helper.ts");
    writeFileSync(helperPath, 'export const value = "two";\n');
    const changedAt = new Date(Date.now() + 1000);
    utimesSync(helperPath, changedAt, changedAt);
    await waitForCount(() => touchedRouteFiles, 1);
    expect(touchedRouteFiles).toBe(1);
  } finally {
    watcher.close();
    rmSync(projectRoot, { force: true, recursive: true });
  }
});

test.serial("the dev topology watcher reports a route error and keeps polling", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "furin-route-error-watch-"));
  const pagesDir = join(projectRoot, "src/pages");
  mkdirSync(pagesDir, { recursive: true });
  const routePath = join(pagesDir, "index.ts");
  writeFileSync(routePath, "export const route = 1;\n");

  let attempts = 0;
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  const watcher = registerDevRouteTopologyWatcher({
    instance: { pagesDir, prefix: "" },
    onRouteFilesTouched: () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error(`${routePath}: use a static layout route reference`);
      }
    },
    onTopologyChange: () => undefined,
    pollIntervalMs: 20,
  });

  try {
    writeFileSync(routePath, "export const route = 2;\n");
    await waitForCount(() => attempts, 2);

    expect(errorSpy).toHaveBeenCalledWith(
      "[furin] Failed to refresh route topology",
      expect.objectContaining({ message: `${routePath}: use a static layout route reference` })
    );
  } finally {
    watcher.close();
    errorSpy.mockRestore();
    rmSync(projectRoot, { force: true, recursive: true });
  }
});
