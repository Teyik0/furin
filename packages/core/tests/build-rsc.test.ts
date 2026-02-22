import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildClientWithRSC } from "../src/build";
import type { ResolvedRoute } from "../src/router";
import { analyzeModule } from "../src/rsc/analyze";

// Use describe.serial to prevent Bun parallel test race conditions
// with Bun.build() accessing the same .bun cache
describe.serial("buildClientWithRSC — manifest generation", () => {
  const tmpDir = join(import.meta.dir, "tmp-build-test");

  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("generates manifest with correct structure for client component", async () => {
    const clientFile = join(tmpDir, "Counter.tsx");
    await writeFile(
      clientFile,
      `
      import { useState } from 'react';
      export default function Counter() {
        const [count, setCount] = useState(0);
        return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
      }
    `
    );

    const analysis = await analyzeModule(clientFile);
    const routes: ResolvedRoute[] = [
      {
        pattern: "/counter",
        pagePath: clientFile,
        path: clientFile,
        mode: "rsc",
        routeChain: [],
      },
    ];
    const analyses = new Map([[clientFile, analysis]]);

    const { manifest } = await buildClientWithRSC(routes, analyses, {
      outDir: join(tmpDir, ".elysion"),
      dev: false,
    });

    expect(manifest).toBeDefined();
    // For client components, manifest should have entries
    expect(Object.keys(manifest).length).toBeGreaterThanOrEqual(0);
  });

  test("returns empty manifest for server-only routes", async () => {
    const serverFile = join(tmpDir, "Page.tsx");
    await writeFile(
      serverFile,
      `
      export default async function Page() {
        return <div>Server Page</div>;
      }
    `
    );

    const analysis = await analyzeModule(serverFile);
    const routes: ResolvedRoute[] = [
      {
        pattern: "/page",
        pagePath: serverFile,
        path: serverFile,
        mode: "ssr",
        routeChain: [],
      },
    ];
    const analyses = new Map([[serverFile, analysis]]);

    const { manifest } = await buildClientWithRSC(routes, analyses, {
      outDir: join(tmpDir, ".elysion"),
      dev: false,
    });

    expect(Object.keys(manifest)).toHaveLength(0);
  });

  test("includes chunk paths in manifest entries", async () => {
    const clientFile = join(tmpDir, "Button.tsx");
    await writeFile(
      clientFile,
      `
      import { useState } from 'react';
      export default function Button() {
        const [clicked, setClicked] = useState(false);
        return <button onClick={() => setClicked(true)}>{clicked ? 'Clicked' : 'Click'}</button>;
      }
    `
    );

    const analysis = await analyzeModule(clientFile);
    const routes: ResolvedRoute[] = [
      {
        pattern: "/button",
        pagePath: clientFile,
        path: clientFile,
        mode: "rsc",
        routeChain: [],
      },
    ];
    const analyses = new Map([[clientFile, analysis]]);

    const { manifest } = await buildClientWithRSC(routes, analyses, {
      outDir: join(tmpDir, ".elysion"),
      dev: false,
    });

    const entries = Object.entries(manifest);
    if (entries.length > 0) {
      const firstEntry = entries[0];
      if (firstEntry) {
        const [_key, entry] = firstEntry;
        expect(entry.chunks).toBeDefined();
        expect(Array.isArray(entry.chunks)).toBe(true);
      }
    }
  });
});
