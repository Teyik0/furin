import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { evaluate } from "@mdx-js/mdx";
import { RouterContext } from "@teyik0/furin/link";
import stripServer from "@teyik0/furin/strip-plugin";
import { Elysia } from "elysia";
import { act, createElement } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToReadableStream } from "react-dom/server";
import { installDom, uninstallDom } from "../../../packages/core/tests/support/dom";
import { DocContent } from "../src/components/doc-content";
import { renderDocContent } from "../src/lib/doc-content";
import { DOCS_BY_PATH } from "../src/lib/docs";
import { getDocSourceText } from "../src/lib/docs-server";
import rehypeHighlight from "../src/lib/rehype-highlight";
import { createDocsServer } from "../src/server";

test("the sync documentation renders its server content, highlighted code and internal links", async () => {
  const app = await createDocsServer();
  const response = await app.handle(new Request("http://localhost/docs/sync"));
  const html = await response.text();

  expect(response.status).toBe(200);
  expect(html).toContain("Sync &amp; Invalidations");
  expect(html).toContain("Configure One Runtime");
  expect(html).toContain("th-keyword");
  expect(html).toContain('href="/docs/caching"');
  expect(html).not.toContain("__FURIN_DEV_DIAGNOSTIC__");
});

test("server-rendered MDX slots hydrate interactive code tabs and internal links", async () => {
  const compiled = await evaluate(
    '[Routing](/docs/routing)\n\n<CodeTabs>\n<CodeTab title="server.ts">\n\n```ts\nexport const port = 3000;\n```\n\n</CodeTab>\n<CodeTab title="client.ts">\n\n```ts\nexport const name = "Furin";\n```\n\n</CodeTab>\n</CodeTabs>',
    { Fragment, jsx, jsxs, rehypePlugins: [rehypeHighlight] }
  );
  const src = await renderDocContent(compiled.default);
  const app = new Elysia().get(
    "/docs/slots",
    async () => new Response(await renderToReadableStream(createElement(DocContent, { src })))
  );
  const response = await app.handle(new Request("http://localhost/docs/slots"));
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("server.ts");
  expect(html).toContain("client.ts");
  expect(html).toContain('href="/docs/routing"');
  expect(html).toContain("th-keyword");
  expect(html).not.toContain("<furin-rsc-slot");

  installDom();
  let root: Root | undefined;
  const navigations: string[] = [];
  try {
    const container = document.createElement("div");
    container.innerHTML = html;
    await act(() => {
      root = hydrateRoot(
        container,
        createElement(
          RouterContext.Provider,
          {
            value: {
              basePath: "",
              currentHref: "/docs/slots",
              defaultPreload: "intent",
              defaultPreloadDelay: 50,
              defaultPreloadStaleTime: 30_000,
              invalidatePrefetch: () => undefined,
              isNavigating: false,
              navigate: (href) => {
                navigations.push(href);
                return Promise.resolve();
              },
              prefetch: () => undefined,
              refresh: () => Promise.resolve(),
              search: {},
              searchRoutes: [],
            },
          },
          createElement(DocContent, { src })
        )
      );
    });
    expect(container.querySelector("pre code")?.textContent).toBe("export const port = 3000;\n");
    await act(() => container.querySelectorAll("button")[1]?.click());
    expect(container.querySelector("pre code")?.textContent).toBe('export const name = "Furin";\n');
    await act(() => container.querySelector("a")?.click());
    expect(navigations).toEqual(["/docs/routing"]);
  } finally {
    await act(() => root?.unmount());
    await uninstallDom();
  }
});

test("getting started preserves its server content without bundling its MDX in the browser", async () => {
  const app = await createDocsServer();
  const response = await app.handle(new Request("http://localhost/docs/getting-started"));
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toContain("Project Structure");
  expect(html).toContain("th-keyword");
  expect(html).toContain('href="/docs/api-routes"');
  expect(html).not.toContain("__FURIN_DEV_DIAGNOSTIC__");

  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../src/pages/docs/getting-started.tsx", import.meta.url))],
    external: ["*"],
    plugins: [stripServer],
    target: "browser",
  });
  expect(build.success).toBe(true);
  expect(await build.outputs[0]?.text()).not.toContain("getting-started.mdx");
});

test("every documentation page keeps its MDX content on the server", async () => {
  const app = await createDocsServer();
  const paths = Object.keys(DOCS_BY_PATH);
  const indexPages = new Map([
    ["/docs", "index"],
    ["/docs/desktop", "desktop/index"],
  ]);
  await Promise.all(
    paths.map(async (path) => {
      const response = await app.handle(new Request(`http://localhost${path}`));
      const html = await response.text();
      const heading = getDocSourceText(DOCS_BY_PATH[path].sourcePath)
        .split("\n")
        .find((line) => line.startsWith("# "))
        ?.slice(2)
        .trimEnd();
      expect(response.status).toBe(200);
      expect(heading).toBeDefined();
      expect(html).toContain(heading?.replaceAll("&", "&amp;") ?? "");
      expect(html).not.toContain("__FURIN_DEV_DIAGNOSTIC__");
    })
  );
  const build = await Bun.build({
    entrypoints: paths.map((path) =>
      fileURLToPath(
        new URL(`../src/pages/docs/${indexPages.get(path) ?? path.slice(6)}.tsx`, import.meta.url)
      )
    ),
    external: ["*"],
    plugins: [stripServer],
    target: "browser",
  });
  expect(build.success).toBe(true);
  expect(build.outputs).toHaveLength(paths.length);
  await Promise.all(
    build.outputs.map(async (output) => {
      const bundle = await output.text();
      expect(bundle).not.toContain(".mdx");
      expect(bundle).not.toContain("renderDocContent");
    })
  );
}, 30_000);

test("documentation Markdown URLs work on the development server", async () => {
  const app = await createDocsServer();
  await Promise.all(
    [
      "/docs.md",
      "/docs/getting-started.md",
      "/docs/desktop.md",
      "/docs/desktop/installation.md",
    ].map(async (path) => {
      const response = await app.handle(new Request(`http://localhost${path}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(await response.text()).not.toContain("<!DOCTYPE html>");
    })
  );
  const missing = await app.handle(new Request("http://localhost/docs/does-not-exist.md"));
  expect(missing.status).toBe(404);
});

const SIDEBAR_NAV_RE = /<nav[^>]*aria-label="Documentation"[^>]*>([\s\S]*?)<\/nav>/;

test("documentation uses sidebar navigation without a duplicate page tab bar", async () => {
  const app = await createDocsServer();
  const response = await app.handle(new Request("http://localhost/docs/getting-started"));
  const html = await response.text();
  expect(response.status).toBe(200);
  const navigation = html.match(SIDEBAR_NAV_RE)?.[1];
  expect(navigation).toBeDefined();
  expect(html).not.toContain('aria-label="Open documentation pages"');
  expect(navigation).toContain('href="/docs/getting-started"');
  expect(navigation).toContain('href="/docs/comparison"');
  expect(html).toContain("Create a Furin application with Bun");
});

test("Desktop docs use the shared layout with their own navigation and product switch", async () => {
  const app = await createDocsServer();
  const response = await app.handle(new Request("http://localhost/docs/desktop"));
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toContain('aria-label="Documentation platform"');
  expect(html).toContain("Desktop overview");
  expect(html).toContain("Search desktop docs");
  const sidebar = html.match(SIDEBAR_NAV_RE)?.[1];
  expect(sidebar).toContain('href="/docs/desktop/first-window"');
  expect(sidebar).not.toContain('href="/docs/routing"');
  expect(html).toContain('href="/docs/desktop.md"');
});

const PAGER_NAV_RE = /<nav[^>]*aria-label="Adjacent documentation pages"[^>]*>([\s\S]*?)<\/nav>/;

test("previous and next never cross the Web and Desktop documentation boundary", async () => {
  const app = await createDocsServer();
  const web = await (await app.handle(new Request("http://localhost/docs/dev-hmr"))).text();
  const desktop = await (await app.handle(new Request("http://localhost/docs/desktop"))).text();
  expect(web.match(PAGER_NAV_RE)?.[1]).not.toContain('data-direction="next"');
  expect(desktop.match(PAGER_NAV_RE)?.[1]).not.toContain('data-direction="previous"');
  expect(desktop.match(PAGER_NAV_RE)?.[1]).toContain('href="/docs/desktop/installation"');
});

test("Desktop LLM indexes and nested Markdown aliases are served without the Web guides", async () => {
  const app = await createDocsServer();
  const response = await app.handle(new Request("http://localhost/docs/desktop/llms.txt"));
  const index = await response.text();
  expect(response.status).toBe(200);
  expect(index).toContain("/docs/desktop/installation.md");
  expect(index).not.toContain("/docs/getting-started.md");
  const alias = await app.handle(
    new Request("http://localhost/docs/desktop/installation/llms.txt")
  );
  expect(alias.status).toBe(200);
  expect(await alias.text()).toContain("# Desktop installation");
});
