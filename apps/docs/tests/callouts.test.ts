import { expect, test } from "bun:test";
import { evaluate } from "@mdx-js/mdx";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { rehypeCallouts } from "../src/lib/rehype-callouts";

const runtime = { Fragment, jsx, jsxs };
const compile = async (markdown: string) =>
  evaluate(markdown, { ...runtime, rehypePlugins: [rehypeCallouts] });

test("a NOTE alert becomes a titled callout", async () => {
  const compiled = await compile("> [!NOTE]\n> Runs only on Bun.\n");
  const html = renderToStaticMarkup(compiled.default({}));

  expect(html).toContain('class="callout callout-note"');
  expect(html).toContain(">Note</span>");
  expect(html).toContain("Runs only on Bun.");
  expect(html).not.toContain("[!NOTE]");
  expect(html).toContain("callout-icon");
});

test("each alert keyword maps to its own variant class", async () => {
  const inputs = ["tip", "important", "warning", "caution"];
  const compiles = await Promise.all(
    inputs.map((kind) => compile(`> [!${kind.toUpperCase()}]\n> Marker line.\n`))
  );

  for (const [index, compiled] of compiles.entries()) {
    const html = renderToStaticMarkup(compiled.default({}));
    expect(html).toContain(`callout-${inputs[index]}`);
  }
});

test("regular blockquotes are untouched", async () => {
  const compiled = await compile("> Just quoting someone.\n");
  const html = renderToStaticMarkup(compiled.default({}));

  expect(html).toContain("<blockquote");
  expect(html).not.toContain("callout");
});

test("the callout keeps surrounding paragraphs and real content", async () => {
  const compiled = await compile("Before.\n\n> [!WARNING]\n> Short body.\n\nAfter.\n");
  const html = renderToStaticMarkup(compiled.default({}));

  expect(html.indexOf("Before.")).toBeLessThan(html.indexOf("callout-warning"));
  expect(html.indexOf("callout-warning")).toBeLessThan(html.indexOf("After."));
  expect(html).toContain("<p>Short body.</p>");
});
