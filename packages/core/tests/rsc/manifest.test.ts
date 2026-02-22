import { describe, expect, test } from "bun:test";
import {
  createManifestEntry,
  generateClientManifest,
  resolveClientReference,
} from "../../src/rsc/manifest";
import type { ClientManifest, ModuleAnalysis } from "../../src/rsc/types";

describe("generateClientManifest", () => {
  test("generates manifest for single export client component", () => {
    const analyses: ModuleAnalysis[] = [
      {
        path: "/src/components/Counter.tsx",
        type: "client",
        exports: [{ name: "Counter", type: "client" }],
        clientFeatures: ["useState"],
      },
    ];

    const outputs = [{ path: "/dist/Counter.a1b2.js", moduleIds: ["/src/components/Counter.tsx"] }];

    const manifest = generateClientManifest(analyses, outputs);

    // Key should be path#name format
    expect(manifest["/src/components/Counter.tsx#Counter"]).toBeDefined();
    expect(manifest["/src/components/Counter.tsx#Counter"]?.name).toBe("Counter");
    expect(manifest["/src/components/Counter.tsx#Counter"]?.chunks).toContain("Counter.a1b2.js");
  });

  test("generates manifest for multiple client components", () => {
    const analyses: ModuleAnalysis[] = [
      {
        path: "/src/components/Counter.tsx",
        type: "client",
        exports: [{ name: "Counter", type: "client" }],
        clientFeatures: ["useState"],
      },
      {
        path: "/src/components/Button.tsx",
        type: "client",
        exports: [{ name: "Button", type: "client" }],
        clientFeatures: ["onClick"],
      },
    ];

    const outputs = [
      { path: "/dist/Counter.a1b2.js", moduleIds: ["/src/components/Counter.tsx"] },
      { path: "/dist/Button.c3d4.js", moduleIds: ["/src/components/Button.tsx"] },
    ];

    const manifest = generateClientManifest(analyses, outputs);

    expect(Object.keys(manifest)).toHaveLength(2);
    expect(manifest["/src/components/Counter.tsx#Counter"]).toBeDefined();
    expect(manifest["/src/components/Button.tsx#Button"]).toBeDefined();
  });

  test("skips server components", () => {
    const analyses: ModuleAnalysis[] = [
      {
        path: "/src/components/Server.tsx",
        type: "server",
        exports: [{ name: "Server", type: "server" }],
        clientFeatures: [],
      },
    ];

    const manifest = generateClientManifest(analyses, []);

    expect(Object.keys(manifest)).toHaveLength(0);
  });

  test("handles multiple exports from same module", () => {
    const analyses: ModuleAnalysis[] = [
      {
        path: "/src/components/index.tsx",
        type: "client",
        exports: [
          { name: "Counter", type: "client" },
          { name: "Button", type: "client" },
        ],
        clientFeatures: ["useState"],
      },
    ];

    const outputs = [{ path: "/dist/index.js", moduleIds: ["/src/components/index.tsx"] }];

    const manifest = generateClientManifest(analyses, outputs);

    expect(manifest["/src/components/index.tsx#Counter"]).toBeDefined();
    expect(manifest["/src/components/index.tsx#Button"]).toBeDefined();
  });

  test("handles empty inputs", () => {
    const manifest = generateClientManifest([], []);
    expect(Object.keys(manifest)).toHaveLength(0);
  });
});

describe("createManifestEntry", () => {
  test("creates entry for single export", () => {
    const entry = createManifestEntry("/src/Counter.tsx", "Counter", ["Counter.a1b2.js"]);

    expect(entry.id).toBe("/src/Counter.tsx#Counter");
    expect(entry.name).toBe("Counter");
    expect(entry.chunks).toEqual(["Counter.a1b2.js"]);
  });

  test("creates entry with default export", () => {
    const entry = createManifestEntry("/src/Page.tsx", "default", ["Page.js"]);

    expect(entry.id).toBe("/src/Page.tsx#default");
    expect(entry.name).toBe("default");
  });
});

describe("resolveClientReference", () => {
  test("resolves reference from manifest", () => {
    const manifest: ClientManifest = {
      "/src/Counter.tsx#Counter": {
        id: "/src/Counter.tsx#Counter",
        name: "Counter",
        chunks: ["Counter.a1b2.js"],
      },
    };

    const ref = resolveClientReference("/src/Counter.tsx#Counter", manifest);

    expect(ref).toBeDefined();
    expect(ref?.name).toBe("Counter");
  });

  test("returns undefined for missing reference", () => {
    const manifest: ClientManifest = {};
    const ref = resolveClientReference("/src/missing.tsx#Missing", manifest);
    expect(ref).toBeUndefined();
  });
});
