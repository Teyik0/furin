import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeAllPages } from "../src/rsc/analyze";
import type { ModuleAnalysis } from "../src/rsc/types";

describe("E2E RSC — analysis integration", () => {
  const tmpDir = join(import.meta.dir, "tmp-e2e-analyze");

  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("analyzes client component file", async () => {
    const clientFile = join(tmpDir, "Client.tsx");
    await writeFile(
      clientFile,
      `
      import { useState } from 'react';
      export function Counter() {
        const [count, setCount] = useState(0);
        return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
      }
    `
    );

    const analyses = new Map<string, ModuleAnalysis>();
    const analysis = await import("../src/rsc/analyze").then((m) => m.analyzeModule(clientFile));
    analyses.set(clientFile, analysis);

    expect(analysis.type).toBe("client");
    expect(analysis.clientFeatures).toContain("useState");
  });

  test("analyzes server component file", async () => {
    const serverFile = join(tmpDir, "Server.tsx");
    await writeFile(
      serverFile,
      `
      export async function ServerPage() {
        const data = await fetchData();
        return <div>{data}</div>;
      }
    `
    );

    const analysis = await import("../src/rsc/analyze").then((m) => m.analyzeModule(serverFile));

    expect(analysis.type).toBe("server");
    expect(analysis.clientFeatures).toHaveLength(0);
  });

  test("respects file suffix for forced types", async () => {
    const forcedClientFile = join(tmpDir, "Forced.client.tsx");
    const forcedServerFile = join(tmpDir, "Forced.server.tsx");

    await writeFile(forcedClientFile, "export function Component() { return <div />; }");
    await writeFile(
      forcedServerFile,
      "export function Component() { const [x, setX] = useState(0); return <div />; }"
    );

    const clientAnalysis = await import("../src/rsc/analyze").then((m) =>
      m.analyzeModule(forcedClientFile)
    );
    const serverAnalysis = await import("../src/rsc/analyze").then((m) =>
      m.analyzeModule(forcedServerFile)
    );

    expect(clientAnalysis.type).toBe("client");
    expect(serverAnalysis.type).toBe("server");
  });

  test("analyzeAllPages processes multiple routes", async () => {
    const file1 = join(tmpDir, "Page1.tsx");
    const file2 = join(tmpDir, "Page2.tsx");

    await writeFile(
      file1,
      "export function Page1() { const [x, setX] = useState(0); return <div />; }"
    );
    await writeFile(file2, "export function Page2() { return <div />; }");

    const routes = [
      { pattern: "/page1", pagePath: file1 },
      { pattern: "/page2", pagePath: file2 },
    ];

    const analyses = await analyzeAllPages(routes);

    expect(analyses.size).toBe(2);
    expect(analyses.get(file1)?.type).toBe("client");
    expect(analyses.get(file2)?.type).toBe("server");
  });
});
