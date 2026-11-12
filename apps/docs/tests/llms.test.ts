import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { DOCS_CARDS } from "../src/lib/docs";
import { stripMdxToMarkdown } from "../src/lib/strip-mdx";

const docsDir = resolve(import.meta.dir, "..");
const baseUrl = "https://teyik0.github.io/furin";

test("generates a fetchable Markdown index and current content for every page", async () => {
  const result = Bun.spawnSync(["bun", "run", "scripts/generate-llms-txt.ts"], { cwd: docsDir });
  expect(result.exitCode).toBe(0);
  const index = await Bun.file(`${docsDir}/public/llms.txt`).text();
  const full = await Bun.file(`${docsDir}/public/llms-full.txt`).text();
  expect(index).not.toContain("https://furin.dev");
  const { DOCS_LLMS } = await import("../src/generated/docs-llms");
  await Promise.all(
    Object.entries(DOCS_LLMS).map(async ([path, content]) => {
      expect(await Bun.file(`${docsDir}/public/${path}`).text()).toBe(content);
    })
  );
  await Promise.all(
    DOCS_CARDS.map(async (doc) => {
      const markdownUrl = `${baseUrl}${doc.href}.md`;
      expect(index).toContain(`](${markdownUrl})`);
      const markdown = await Bun.file(`${docsDir}/public${doc.href}.md`).text();
      const source = stripMdxToMarkdown(await Bun.file(`${docsDir}/${doc.sourcePath}`).text());
      expect(markdown.trim()).toBe(source.replaceAll("](/docs", `](${baseUrl}/docs`));
      expect(full).toContain(markdown.trim());
      if (doc.href !== "/docs" && doc.href !== "/docs/desktop") {
        expect(await Bun.file(`${docsDir}/public${doc.href}/llms.txt`).text()).toBe(markdown);
      }
    })
  );
  const webIndex = await Bun.file(`${docsDir}/public/docs/llms.txt`).text();
  const desktopIndex = await Bun.file(`${docsDir}/public/docs/desktop/llms.txt`).text();
  expect(webIndex).toContain(`](${baseUrl}/docs/getting-started.md)`);
  expect(webIndex).not.toContain(`](${baseUrl}/docs/desktop.md)`);
  expect(desktopIndex).toContain(`](${baseUrl}/docs/desktop.md)`);
  expect(desktopIndex).not.toContain(`](${baseUrl}/docs/getting-started.md)`);
  expect(await Bun.file(`${docsDir}/public/docs/desktop/llms-full.txt`).text()).toContain(
    "# Desktop overview"
  );
});
