import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedRoute } from "../../src/router";
import { analyzeAllPages, analyzeModule } from "../../src/rsc/analyze";

describe("analyzeModule", () => {
  const tmpDir = join(import.meta.dir, "..", "tmp-analyze-test");

  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("analyzes client component with hooks", async () => {
    const filePath = join(tmpDir, "Counter.tsx");
    await writeFile(
      filePath,
      `
      import { useState } from 'react';
      export function Counter() {
        const [count, setCount] = useState(0);
        return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
      }
    `
    );

    const result = await analyzeModule(filePath);

    expect(result.type).toBe("client");
    expect(result.clientFeatures).toContain("useState");
    expect(result.clientFeatures.some((f) => f.includes("onClick"))).toBe(true);
    expect(result.path).toBe(filePath);
  });

  test("analyzes server component without client features", async () => {
    const filePath = join(tmpDir, "UserProfile.tsx");
    await writeFile(
      filePath,
      `
      export async function UserProfile({ id }: { id: string }) {
        const user = await db.users.find(id);
        return <div>{user.name}</div>;
      }
    `
    );

    const result = await analyzeModule(filePath);

    expect(result.type).toBe("server");
    expect(result.clientFeatures).toHaveLength(0);
  });

  test("respects .client.tsx suffix", async () => {
    const filePath = join(tmpDir, "Button.client.tsx");
    await writeFile(
      filePath,
      `
      export function Button() {
        return <button>Click</button>;
      }
    `
    );

    const result = await analyzeModule(filePath);

    expect(result.type).toBe("client");
    expect(result.exports).toHaveLength(1);
    expect(result.exports[0]?.name).toBe("Button");
    expect(result.exports[0]?.type).toBe("client");
  });

  test("respects .server.tsx suffix", async () => {
    const filePath = join(tmpDir, "Card.server.tsx");
    await writeFile(
      filePath,
      `
      import { useState } from 'react';
      export function Card() {
        const [x, setX] = useState(0);
        return <div>{x}</div>;
      }
    `
    );

    const result = await analyzeModule(filePath);

    expect(result.type).toBe("server");
  });

  test("analyzes exports and marks them correctly", async () => {
    const filePath = join(tmpDir, "Mixed.tsx");
    await writeFile(
      filePath,
      `
      export function ServerComponent() {
        return <div>Server</div>;
      }
      
      export function ClientComponent() {
        const [x, setX] = useState(0);
        return <button onClick={() => setX(x + 1)}>{x}</button>;
      }
    `
    );

    const result = await analyzeModule(filePath);

    expect(result.type).toBe("client");
    expect(result.exports.length).toBeGreaterThan(0);
  });

  test("handles file with no exports", async () => {
    const filePath = join(tmpDir, "Empty.tsx");
    await writeFile(filePath, "const x = 1;");

    const result = await analyzeModule(filePath);

    expect(result.type).toBe("server");
    expect(result.exports).toHaveLength(0);
  });

  test("detects default export function with name", async () => {
    const filePath = join(tmpDir, "Page.tsx");
    await writeFile(
      filePath,
      `
      export default function Page() {
        return <div>Page</div>;
      }
    `
    );

    const result = await analyzeModule(filePath);

    expect(result.exports.some((e) => e.name === "Page")).toBe(true);
  });

  test("detects anonymous default export as 'default'", async () => {
    const filePath = join(tmpDir, "Anonymous.tsx");
    await writeFile(
      filePath,
      `
      export default () => {
        return <div>Anonymous</div>;
      };
    `
    );

    const result = await analyzeModule(filePath);

    expect(result.exports.some((e) => e.name === "default")).toBe(true);
  });

  test("detects default export expression as 'default'", async () => {
    const filePath = join(tmpDir, "Component.tsx");
    await writeFile(
      filePath,
      `
      const Component = () => <div>Component</div>;
      export default Component;
    `
    );

    const result = await analyzeModule(filePath);

    expect(result.exports.some((e) => e.name === "default")).toBe(true);
  });

  test("detects multiple exports including default", async () => {
    const filePath = join(tmpDir, "Mixed.tsx");
    await writeFile(
      filePath,
      `
      export function Named() {
        return <div>Named</div>;
      }
      
      export default function Page() {
        return <div>Page</div>;
      }
    `
    );

    const result = await analyzeModule(filePath);

    expect(result.exports.some((e) => e.name === "Named")).toBe(true);
    expect(result.exports.some((e) => e.name === "Page")).toBe(true);
    expect(result.exports).toHaveLength(2);
  });
});

describe("analyzeAllPages", () => {
  const tmpDir = join(import.meta.dir, "..", "tmp-analyze-pages");

  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("analyzes multiple routes", async () => {
    const page1 = join(tmpDir, "index.tsx");
    const page2 = join(tmpDir, "dashboard.tsx");

    await writeFile(
      page1,
      `
      export default function Home() {
        return <div>Home</div>;
      }
    `
    );

    await writeFile(
      page2,
      `
      import { useState } from 'react';
      export default function Dashboard() {
        const [count, setCount] = useState(0);
        return <div>{count}</div>;
      }
    `
    );

    const routes: ResolvedRoute[] = [
      { pattern: "/", pagePath: page1 } as ResolvedRoute,
      { pattern: "/dashboard", pagePath: page2 } as ResolvedRoute,
    ];

    const result = await analyzeAllPages(routes);

    expect(result.size).toBe(2);
    expect(result.get(page1)?.type).toBe("server");
    expect(result.get(page2)?.type).toBe("client");
  });

  test("handles empty routes array", async () => {
    const result = await analyzeAllPages([]);
    expect(result.size).toBe(0);
  });

  test("skips routes without pagePath or nonexistent files", async () => {
    const routes = [
      { pattern: "/" } as ResolvedRoute,
      { pattern: "/dashboard", pagePath: join(tmpDir, "nonexistent.tsx") } as ResolvedRoute,
    ];

    const result = await analyzeAllPages(routes);
    expect(result.size).toBe(0);
  });
});
