import { furin } from "@teyik0/furin";
import { type AnyElysia, Elysia } from "elysia";
import { initLogger } from "evlog";
import { DOCS_LLMS } from "./generated/docs-llms";
import mdxPlugin from "./lib/bun-mdx-plugin.ts";
import { DOCS_CARDS, getDocByPath } from "./lib/docs";
import { getSearchIndexEntries, searchDocs } from "./lib/docs-search";
import { getDocSourceText } from "./lib/docs-server";
import { stripMdxToMarkdown } from "./lib/strip-mdx";

initLogger({ env: { service: "furin-docs" } });

function markdownFile(path: keyof typeof DOCS_LLMS): Response {
  return new Response(DOCS_LLMS[path], {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

const globalDocsRuntime = globalThis as typeof globalThis & {
  __furinDocsMdxPluginRegistered?: boolean;
};

if (!globalDocsRuntime.__furinDocsMdxPluginRegistered) {
  Bun.plugin(mdxPlugin);
  globalDocsRuntime.__furinDocsMdxPluginRegistered = true;
}

function markdownResponse(path: string): Response {
  const doc = getDocByPath(path);
  if (!doc) {
    return new Response("Not found", { status: 404 });
  }
  const clean = stripMdxToMarkdown(getDocSourceText(doc.sourcePath));
  return new Response(`${clean}\n`, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

export async function createDocsServer() {
  return (
    new Elysia()
      .get("/llms.txt", () => markdownFile("llms.txt"))
      .get("/llms-full.txt", () => markdownFile("llms-full.txt"))
      .get("/docs/llms.txt", () => markdownFile("docs/llms.txt"))
      .get("/docs/llms-full.txt", () => markdownFile("docs/llms-full.txt"))
      .get("/docs/desktop/llms.txt", () => markdownFile("docs/desktop/llms.txt"))
      .get("/docs/desktop/llms-full.txt", () => markdownFile("docs/desktop/llms-full.txt"))
      .get("/docs/desktop/:slug/llms.txt", ({ params }) =>
        markdownResponse(`/docs/desktop/${params.slug}`)
      )
      .get("/docs/:slug/llms.txt", ({ params }) => markdownResponse(`/docs/${params.slug}`))
      // Static JSON used by the client-side search in both dev and static deployments.
      // The same file is pre-generated into public/ by generate:content for static builds.
      .get("/search-entries.json", () => Response.json(getSearchIndexEntries("web")))
      .get("/docs/desktop/search-entries.json", () =>
        Response.json(getSearchIndexEntries("desktop"))
      )
      .get("/api/search", async ({ request }) => {
        const url = new URL(request.url);
        const q = url.searchParams.get("q") ?? "";
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? Number(limitParam) : undefined;

        return {
          query: q,
          results: await searchDocs(
            q,
            limit,
            url.searchParams.get("platform") === "desktop" ? "desktop" : "web"
          ),
        };
      })
      .use(
        DOCS_CARDS.reduce<AnyElysia>(
          (routes, doc) => routes.get(`${doc.href}.md`, () => markdownResponse(doc.href)),
          new Elysia()
        )
      )
      .use(await furin({ pagesDir: "./src/pages", style: "tanstack" }))
  );
}

const app = await createDocsServer();
export const port = Number(process.env.PORT ?? 3000);

if (import.meta.main) {
  app.listen(port);
  console.log(`Furin Docs running at http://localhost:${app.server?.port}`);
}

export default app;
