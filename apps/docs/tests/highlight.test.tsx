import { expect, test } from "bun:test";
import { evaluate } from "@mdx-js/mdx";
import { createElement } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { visitParents } from "unist-util-visit-parents";
import { installDom } from "../../../packages/core/tests/support/dom";
import { CodeTab, CodeTabs } from "../src/components/code-tabs";
import { highlighter } from "../src/lib/highlight";
import rehypeHighlight from "../src/lib/rehype-highlight";

installDom();
const runtime = { Fragment, jsx, jsxs };

test("MDX highlighting preserves code text split by an earlier rehype plugin", async () => {
  const source = "export const value = 42;\n";
  const splitText = () => (tree: Parameters<ReturnType<typeof rehypeHighlight>>[0]) => {
    visitParents(tree, "element", (node) => {
      if (node.tagName === "code") {
        node.children = [
          { type: "text", value: "export const " },
          { type: "text", value: "value = 42;\n" },
        ];
      }
    });
  };
  const compiled = await evaluate(`\`\`\`ts\n${source}\`\`\``, {
    ...runtime,
    rehypePlugins: [splitText, rehypeHighlight],
  });
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(createElement(compiled.default));
  expect(container.querySelector("pre code")?.textContent).toBe(source);
});

test("MDX highlights TSX while preserving its filename window and source text", async () => {
  const source = "export const App = () => <button>Click</button>;\n";
  const compiled = await evaluate(`\`\`\`tsx\n// App.tsx\n${source}\`\`\``, {
    ...runtime,
    rehypePlugins: [rehypeHighlight],
  });
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(createElement(compiled.default));

  expect(container.textContent).toContain("App.tsx");
  expect(container.querySelectorAll("pre")).toHaveLength(1);
  expect(container.querySelector("pre code")?.textContent).toBe(source);
  expect(container.querySelector("pre .th-keyword")?.textContent).toBe("export");
  expect(container.querySelector("pre button")).toBeNull();
  expect(container.querySelector("pre")?.style.padding).toBe("1.25rem 1.5rem");
});

test("MDX code tabs retain a single window and highlight their active content", async () => {
  const compiled = await evaluate(
    '<CodeTabs>\n<CodeTab title="server.ts">\n\n```ts\n// server.ts\nexport const port = 3000;\n```\n\n</CodeTab>\n<CodeTab title="client.ts">\n\n```ts\n// client.ts\nexport const name = "Furin";\n```\n\n</CodeTab>\n</CodeTabs>',
    { ...runtime, rehypePlugins: [rehypeHighlight] }
  );
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    createElement(compiled.default, { components: { CodeTab, CodeTabs } })
  );

  expect(container.querySelectorAll(".not-prose")).toHaveLength(1);
  expect(Array.from(container.querySelectorAll("button"), (button) => button.textContent)).toEqual([
    "server.ts",
    "client.ts",
  ]);
  expect(container.querySelector("pre code")?.textContent).toBe("export const port = 3000;\n");
  expect(container.querySelector("pre .th-keyword")?.textContent).toBe("export");
});

test.each(["", "unknown-language"])("MDX renders %s fences as escaped plaintext", async (lang) => {
  const source = '<script>alert("x")</script> & ready\n';
  const compiled = await evaluate(`\`\`\`${lang}\n${source}\`\`\``, {
    ...runtime,
    rehypePlugins: [rehypeHighlight],
  });
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(createElement(compiled.default));

  expect(container.querySelector("pre code")?.textContent).toBe(source);
  expect(container.querySelector("script")).toBeNull();
});

test.each([
  ["bash", "echo 'Furin'"],
  ["sh", "echo 'Furin'"],
  ["json", '{"name": "Furin"}'],
  ["nginx", "server { listen 80; }"],
  ["toml", '[serve.static]\nplugins = ["furin/strip-plugin"]'],
  ["ts", 'export const name: string = "Furin";'],
  ["tsx", "export const App = () => <button>Click</button>;"],
])("shared highlighter covers the docs' %s snippets", (lang, source) => {
  const container = document.createElement("div");
  container.innerHTML = highlighter.highlightToHtml(source, { lang });

  expect(container.querySelector("code")?.textContent).toBe(source);
  expect(container.querySelector(".th-token")).not.toBeNull();
  expect(container.querySelector("button")).toBeNull();
});
