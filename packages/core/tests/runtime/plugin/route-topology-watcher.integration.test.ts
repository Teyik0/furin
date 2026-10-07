import { expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
  const touchedSources: string[][] = [];
  let touchedRouteFiles = 0;
  const instance = { pagesDir, prefix: "" };
  const watcher = registerDevRouteTopologyWatcher({
    instance,
    onRouteFilesTouched: (sourcePaths) => {
      touchedRouteFiles += 1;
      touchedSources.push([...sourcePaths]);
    },
    onTopologyChange: () => {
      const paths = routeSourcePaths(instance).map((path) => relative(pagesDir, path));
      topologies.push(paths);
    },
  });

  try {
    writeFileSync(join(pagesDir, "index.ts"), "export const route = 2;\n");
    await waitForCount(() => touchedRouteFiles, 1);
    expect(topologies).toHaveLength(0);
    expect(touchedSources[0]).toContain(join(pagesDir, "index.ts"));

    await Bun.sleep(80);
    expect(touchedRouteFiles).toBe(1);

    const nestedDir = join(pagesDir, "boards");
    mkdirSync(nestedDir);
    writeFileSync(join(nestedDir, "[id].ts"), "export const route = 1;\n");
    await waitForCount(() => topologies.length, 1);

    expect(topologies[0]).toContain(join("boards", "[id].ts"));
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

test("a reloaded server mount replaces its watcher without letting stale cleanup stop it", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "furin-route-reload-watch-"));
  const pagesDir = join(projectRoot, "src/pages");
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(join(pagesDir, "index.ts"), "export const route = 1;\n");
  const server = {};
  let staleChanges = 0;
  let currentChanges = 0;
  const previous = registerDevRouteTopologyWatcher({
    instance: { pagesDir, prefix: "" },
    owner: { app: server, prefix: "/admin" },
    onTopologyChange: () => {
      staleChanges += 1;
    },
  });
  const current = registerDevRouteTopologyWatcher({
    instance: { pagesDir, prefix: "" },
    owner: { app: server, prefix: "/admin" },
    onTopologyChange: () => {
      currentChanges += 1;
    },
  });
  try {
    writeFileSync(join(pagesDir, "added.ts"), "export const route = 2;\n");
    await current.refresh();
    await previous.refresh();
    expect(currentChanges).toBe(1);
    expect(staleChanges).toBe(0);
    previous.close();
    writeFileSync(join(pagesDir, "later.ts"), "export const route = 3;\n");
    await current.refresh();
    expect(currentChanges).toBe(2);
    expect(staleChanges).toBe(0);
  } finally {
    previous.close();
    current.close();
    rmSync(projectRoot, { force: true, recursive: true });
  }
});

test("the dev topology watcher observes transitive route dependencies", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "furin-route-dependency-watch-"));
  const pagesDir = join(projectRoot, "src/pages");
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(join(projectRoot, "package.json"), "{}\n");
  const helperPath = join(projectRoot, "src/lib/helper.ts");
  mkdirSync(join(projectRoot, "src/lib"), { recursive: true });
  writeFileSync(helperPath, 'export const value = "one";\n');
  writeFileSync(
    join(pagesDir, "index.ts"),
    'import { value } from "../lib/helper.ts";\nexport const route = value;\n'
  );

  let touchedRouteFiles = 0;
  const watcher = registerDevRouteTopologyWatcher({
    instance: { pagesDir, prefix: "" },
    onRouteFilesTouched: () => {
      touchedRouteFiles += 1;
    },
    onTopologyChange: () => undefined,
  });

  try {
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

test("the dev topology watcher skips installed packages but follows linked project sources", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "furin-route-package-watch-"));
  const pagesDir = join(projectRoot, "src/pages");
  const vendorDir = join(projectRoot, "node_modules/vendor");
  const linkedDir = join(projectRoot, "src/linked");
  mkdirSync(pagesDir, { recursive: true });
  mkdirSync(vendorDir, { recursive: true });
  mkdirSync(linkedDir, { recursive: true });
  writeFileSync(join(projectRoot, "package.json"), "{}\n");
  writeFileSync(join(vendorDir, "package.json"), '{"main":"index.ts"}\n');
  writeFileSync(join(vendorDir, "index.ts"), 'export const vendor = "one";\n');
  writeFileSync(join(linkedDir, "package.json"), '{"main":"index.ts"}\n');
  writeFileSync(join(linkedDir, "index.ts"), 'export const linked = "one";\n');
  symlinkSync(
    linkedDir,
    join(projectRoot, "node_modules/linked"),
    process.platform === "win32" ? "junction" : "dir"
  );
  writeFileSync(
    join(pagesDir, "index.ts"),
    'import "vendor";\nimport "linked";\nexport const route = 1;\n'
  );

  const touchedSources: string[][] = [];
  const watcher = registerDevRouteTopologyWatcher({
    instance: { pagesDir, prefix: "" },
    onRouteFilesTouched: (sourcePaths) => {
      touchedSources.push([...sourcePaths]);
    },
    onTopologyChange: () => undefined,
  });

  try {
    const linkedPath = join(linkedDir, "index.ts");
    expect(realpathSync.native(Bun.resolveSync("linked", pagesDir))).toBe(
      realpathSync.native(linkedPath)
    );
    await Bun.sleep(100);
    const vendorPath = join(vendorDir, "index.ts");
    writeFileSync(vendorPath, 'export const vendor = "two";\n');
    utimesSync(vendorPath, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
    await Bun.sleep(150);
    expect(touchedSources).toHaveLength(0);

    writeFileSync(linkedPath, 'export const linked = "two";\n');
    utimesSync(linkedPath, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
    try {
      await waitForCount(() => touchedSources.length, 1);
    } catch (error) {
      await watcher.refresh();
      throw new Error(
        touchedSources.length === 0
          ? "Linked source is absent from the route dependency graph"
          : "Linked source is tracked, but its filesystem event was missed",
        { cause: error }
      );
    }
    expect(touchedSources[0]).toContain(realpathSync.native(linkedPath));
  } finally {
    watcher.close();
    rmSync(projectRoot, { force: true, recursive: true });
  }
});

test("the dev topology watcher reports source transform errors", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "furin-route-transform-watch-"));
  const pagesDir = join(projectRoot, "src/pages");
  mkdirSync(pagesDir, { recursive: true });
  const routePath = join(pagesDir, "index.ts");
  writeFileSync(routePath, "export const route = 1;\n");

  const sourceErrors: Array<{ error: unknown; sourcePath: string }> = [];
  let touchedRouteFiles = 0;
  const watcher = registerDevRouteTopologyWatcher({
    instance: { pagesDir, prefix: "" },
    onRouteFilesTouched: () => {
      touchedRouteFiles += 1;
    },
    onSourceError: (error, sourcePath) => {
      sourceErrors.push({ error, sourcePath });
    },
    onTopologyChange: () => undefined,
  });

  try {
    writeFileSync(routePath, "export const route = 2;\n");
    await waitForCount(() => touchedRouteFiles, 1);
    writeFileSync(routePath, "export const route = ;\n");
    await waitForCount(() => sourceErrors.length, 1);

    expect(sourceErrors[0]?.sourcePath).toBe(routePath);
    expect(sourceErrors[0]?.error).toBeInstanceOf(Error);
  } finally {
    watcher.close();
    rmSync(projectRoot, { force: true, recursive: true });
  }
});

test("the dev topology watcher can refresh before the filesystem debounce", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "furin-route-eager-watch-"));
  const pagesDir = join(projectRoot, "src/pages");
  mkdirSync(pagesDir, { recursive: true });
  const routePath = join(pagesDir, "index.ts");
  writeFileSync(routePath, "export const route = 1;\n");

  let touchedRouteFiles = 0;
  const watcher = registerDevRouteTopologyWatcher({
    instance: { pagesDir, prefix: "" },
    onRouteFilesTouched: () => {
      touchedRouteFiles += 1;
    },
    onTopologyChange: () => undefined,
  });

  try {
    writeFileSync(routePath, "export const route = 2;\n");
    const changedAt = new Date(Date.now() + 1000);
    utimesSync(routePath, changedAt, changedAt);

    await watcher.refresh();

    expect(touchedRouteFiles).toBe(1);
  } finally {
    watcher.close();
    rmSync(projectRoot, { force: true, recursive: true });
  }
});

test("the dev topology watcher migrates state retained across a soft reload", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "furin-route-legacy-watch-"));
  const pagesDir = join(projectRoot, "src/pages");
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(join(pagesDir, "index.ts"), "export const route = 1;\n");
  const watcher = registerDevRouteTopologyWatcher({
    instance: { pagesDir, prefix: "" },
    onTopologyChange: () => undefined,
  });

  try {
    const registry = Reflect.get(globalThis, Symbol.for("@teyik0/furin/dev-route-watchers"));
    if (!(registry instanceof Map)) {
      throw new Error("Expected the global development watcher registry");
    }
    const states = [...registry.values()] as Array<{
      changedSources?: Set<string>;
      instance?: { pagesDir?: string };
    }>;
    const state = states.find((candidate) => candidate.instance?.pagesDir === pagesDir);
    if (!state) {
      throw new Error("Expected retained development watcher state");
    }
    Reflect.deleteProperty(state, "changedSources");

    await watcher.refresh();

    expect(state.changedSources).toBeInstanceOf(Set);
  } finally {
    watcher.close();
    rmSync(projectRoot, { force: true, recursive: true });
  }
});

test.serial(
  "the dev topology watcher reports a route error and retries reconciliation",
  async () => {
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
  }
);
