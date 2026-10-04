import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import stripServer from "@teyik0/furin/strip-plugin";
import { createDocsServer } from "../src/server";

test("the landing keeps its server content and interactive slots without shipping static JSX", async () => {
  const app = await createDocsServer();
  const response = await app.handle(new Request("http://localhost/"));
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toContain("that rings fast.");
  expect(html).toContain("Your loader is");
  expect(html).toContain("Every tab follows.");
  expect(html).toContain("Zero node_modules.");
  expect(html).toContain("Three layers.");
  expect(html).toContain("Server-side rendering");
  expect(html).toContain('href="/docs"');
  expect(html.match(/<canvas\b/g)).toHaveLength(2);
  expect(html).toContain("sync-card--mover");
  expect(html).toContain("pages/index.tsx");
  expect(html.includes("<furin-rsc-slot")).toBe(false);

  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../src/pages/index.tsx", import.meta.url))],
    packages: "external",
    plugins: [stripServer],
    target: "browser",
  });
  expect(build.success).toBe(true);
  const bundle = await build.outputs[0]?.text();
  expect(bundle).not.toContain("Your loader is");
  expect(bundle).not.toContain("Nothing you have to wire.");
  expect(bundle).not.toContain("Streaming SSR");
  expect(bundle).not.toContain("Fresh HTML streamed");
  expect(bundle).toContain("mode-card group");
  expect(bundle).toContain('setProperty("--p"');
});
