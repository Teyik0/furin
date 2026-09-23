import { expect, test } from "bun:test";

const CORE_DIR_SUFFIX_RE = /\/tests(?:\/.*)?$/;

const DEV_LOADER_CACHE_PRIMITIVES = `
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetDevLoaderCacheState,
  getAllDevSSGLoaderEntries,
  getDevISRLoaderCache,
  getDevSSGLoaderCache,
  invalidateDevLoaderCacheBySource,
  isDevLoaderCacheFresh,
  isDevLoaderCacheValid,
  setDevISRLoaderCache,
  setDevSSGLoaderCache,
} from "./src/server/cache/index.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message + ": expected " + String(expected) + ", got " + String(actual));
  }
}

function makeEntry(overrides) {
  return {
    dependencies: ["/some/page.tsx", "/some/root.tsx"],
    generatedAt: Date.now(),
    headers: {},
    loaderData: { value: "data" },
    mode: "ssg",
    revalidate: Number.POSITIVE_INFINITY,
    ...(overrides ?? {}),
  };
}

function resetDevCache() {
  __resetDevLoaderCacheState();
}

function setupTmp() {
  const dir = mkdtempSync(join(tmpdir(), "furin-cache-validity-"));
  return { cleanup: () => rmSync(dir, { force: true, recursive: true }), dir };
}

resetDevCache();
const entry = makeEntry(undefined);
setDevSSGLoaderCache("/ssg-route", entry);
const cached = getDevSSGLoaderCache("/ssg-route");
assertEqual(cached?.loaderData.value, "data", "cached loader data should round-trip");
assertEqual(cached?.mode, "ssg", "cached entry mode should be ssg");
assert(getDevSSGLoaderCache("/other") === undefined, "other route should miss");

assert(isDevLoaderCacheFresh(makeEntry(undefined)), "SSG entries should be fresh");
assert(
  !isDevLoaderCacheFresh(makeEntry({ generatedAt: Date.now() - 2000, mode: "isr", revalidate: 1 })),
  "stale ISR entry should not be fresh"
);

resetDevCache();
setDevSSGLoaderCache("/ssg-route", makeEntry({ dependencies: ["/pages/ssg.tsx", "/pages/root.tsx"] }));
const ssgResult = invalidateDevLoaderCacheBySource("/pages/ssg.tsx");
assertEqual(ssgResult.ssg, 1, "one SSG entry should be cleared");
assertEqual(ssgResult.isr, 0, "no ISR entry should be cleared");
assert(ssgResult.cleared.includes("/ssg-route"), "cleared keys should include SSG route");
assert(getDevSSGLoaderCache("/ssg-route") === undefined, "entry should be removed");

resetDevCache();
setDevISRLoaderCache("/isr-route", makeEntry({ dependencies: ["/shared.tsx"], mode: "isr", revalidate: 60 }));
setDevSSGLoaderCache("/ssg-route", makeEntry({ dependencies: ["/shared.tsx"] }));
const sharedResult = invalidateDevLoaderCacheBySource("/shared.tsx");
assertEqual(sharedResult.isr + sharedResult.ssg, 2, "both entries should be cleared");
assert(getDevISRLoaderCache("/isr-route") === undefined, "ISR entry should be removed");
assert(getDevSSGLoaderCache("/ssg-route") === undefined, "SSG entry should be removed");

resetDevCache();
setDevSSGLoaderCache("/a", makeEntry({ loaderData: { page: "a" } }));
setDevSSGLoaderCache("/b", makeEntry({ loaderData: { page: "b" } }));
const keys = getAllDevSSGLoaderEntries().map(([key]) => key);
assert(keys.includes("/a"), "SSG entries should include /a");
assert(keys.includes("/b"), "SSG entries should include /b");

resetDevCache();
const dep1 = "/old-dep.tsx";
const dep2 = "/new-dep.tsx";
const nextEntry = makeEntry({ dependencies: [dep2], mode: "isr", revalidate: 60 });
setDevISRLoaderCache("/isr-route", makeEntry({ dependencies: [dep1], mode: "isr", revalidate: 60 }));
assertEqual(invalidateDevLoaderCacheBySource(dep1).isr, 1, "old dependency should clear entry");
setDevISRLoaderCache("/isr-route", nextEntry);
const staleResult = invalidateDevLoaderCacheBySource(dep1);
assertEqual(staleResult.isr, 0, "old dependency should not clear ISR entries");
assertEqual(staleResult.ssg, 0, "old dependency should not clear SSG entries");
assertEqual(staleResult.cleared.length, 0, "old dependency should not clear keys");
setDevISRLoaderCache("/isr-route", nextEntry);
assertEqual(invalidateDevLoaderCacheBySource(dep2).isr, 1, "new dependency should clear entry");

{
  const { cleanup, dir } = setupTmp();
  try {
    const dep = join(dir, "dep.tsx");
    writeFileSync(dep, "// initial content");
    const fiveSecAgo = (Date.now() - 5000) / 1000;
    utimesSync(dep, fiveSecAgo, fiveSecAgo);
    assert(
      isDevLoaderCacheValid({
        dependencies: [dep],
        generatedAt: Date.now(),
        headers: {},
        loaderData: { x: 1 },
        mode: "isr",
        revalidate: 60,
      }),
      "fresh entry with older dependency should be valid"
    );
  } finally {
    cleanup();
  }
}

{
  const { cleanup, dir } = setupTmp();
  try {
    const dep = join(dir, "dep.tsx");
    writeFileSync(dep, "// initial content");
    const fiveSecAgo = (Date.now() - 5000) / 1000;
    utimesSync(dep, fiveSecAgo, fiveSecAgo);
    assert(
      !isDevLoaderCacheValid({
        dependencies: [dep],
        generatedAt: Date.now() - 10_000,
        headers: {},
        loaderData: { x: 1 },
        mode: "isr",
        revalidate: 60,
      }),
      "entry with newer dependency should be invalid"
    );
  } finally {
    cleanup();
  }
}

{
  const { cleanup, dir } = setupTmp();
  try {
    const dep = join(dir, "dep.tsx");
    writeFileSync(dep, "// initial content");
    assert(
      !isDevLoaderCacheValid({
        dependencies: [dep],
        generatedAt: Date.now() - 120_000,
        headers: {},
        loaderData: { x: 1 },
        mode: "isr",
        revalidate: 60,
      }),
      "entry past revalidate window should be invalid"
    );
  } finally {
    cleanup();
  }
}

{
  const { cleanup, dir } = setupTmp();
  try {
    const dep = join(dir, "dep.tsx");
    writeFileSync(dep, "// initial content");
    const fiveSecAgo = (Date.now() - 5000) / 1000;
    utimesSync(dep, fiveSecAgo, fiveSecAgo);
    assert(
      !isDevLoaderCacheValid({
        dependencies: [dep],
        generatedAt: Date.now() - 10_000,
        headers: {},
        loaderData: { x: 1 },
        mode: "ssg",
        revalidate: Number.POSITIVE_INFINITY,
      }),
      "SSG entry with newer dependency should be invalid"
    );
  } finally {
    cleanup();
  }
}

{
  const { cleanup, dir } = setupTmp();
  try {
    assert(
      !isDevLoaderCacheValid({
        dependencies: [join(dir, "deleted.tsx")],
        generatedAt: Date.now(),
        headers: {},
        loaderData: { x: 1 },
        mode: "isr",
        revalidate: 60,
      }),
      "entry with missing dependency should be invalid"
    );
  } finally {
    cleanup();
  }
}

process.exit(0);
`;

test("dev loader cache primitive scenarios", async () => {
  const proc = Bun.spawn({
    cmd: [process.execPath, "-e", DEV_LOADER_CACHE_PRIMITIVES],
    cwd: import.meta.dir.replace(CORE_DIR_SUFFIX_RE, ""),
    stderr: "pipe",
    stdout: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), 10_000);
  let exitCode: number;
  let stdout: string;
  let stderr: string;
  try {
    [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
  } finally {
    clearTimeout(timeout);
  }

  if (exitCode !== 0) {
    throw new Error(
      [`dev loader cache subprocess exited with ${exitCode}`, stdout, stderr].join("\n")
    );
  }

  expect(exitCode).toBe(0);
}, 15_000);
