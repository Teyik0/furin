import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderRSC } from "../src/render";
import type { ResolvedRoute } from "../src/router";
import type { ClientManifest } from "../src/rsc/types";

describe("renderRSC — RSC rendering", () => {
  const tmpDir = join(import.meta.dir, "tmp-render-test");

  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns HTML response", async () => {
    const pageFile = join(tmpDir, "Page.tsx");
    await writeFile(
      pageFile,
      `
      export default function Page() {
        return <div>Hello RSC</div>;
      }
    `
    );

    const route: ResolvedRoute = {
      pattern: "/page",
      pagePath: pageFile,
      path: pageFile,
      mode: "rsc",
      routeChain: [],
    };

    const manifest: ClientManifest = {};

    const response = await renderRSC(route, {}, {}, null, manifest, false);

    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  test("falls back to SSR when RSC runtime not available", async () => {
    const serverFile = join(tmpDir, "ServerPage.tsx");
    await writeFile(
      serverFile,
      `
      export default function ServerPage() {
        return <article>Server-rendered content</article>;
      }
    `
    );

    const route: ResolvedRoute = {
      pattern: "/server",
      pagePath: serverFile,
      path: serverFile,
      mode: "rsc",
      routeChain: [],
    };

    // Empty manifest - RSC should fall back to SSR
    const manifest: ClientManifest = {};
    const response = await renderRSC(route, {}, {}, null, manifest, false);

    // Currently falls back to SSR
    expect(response.status).toBe(200);
    // Response should be HTML
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  test("accepts manifest parameter for future RSC support", async () => {
    const pageFile = join(tmpDir, "Manifest.tsx");
    await writeFile(
      pageFile,
      `
      export default function Manifest() {
        return <div>With Manifest</div>;
      }
    `
    );

    const route: ResolvedRoute = {
      pattern: "/manifest",
      pagePath: pageFile,
      path: pageFile,
      mode: "rsc",
      routeChain: [],
    };

    const manifest: ClientManifest = {
      "/Manifest.tsx#Manifest": {
        id: "Manifest.tsx#Manifest",
        name: "Manifest",
        chunks: ["Manifest.js"],
      },
    };

    const response = await renderRSC(route, {}, {}, null, manifest, false);
    expect(response).toBeInstanceOf(Response);
  });
});
