import { furin } from "@teyik0/furin";
import { Elysia } from "elysia";
import _llmsTxt from "../public/llms.txt" with { type: "file" };
import _llmsFullTxt from "../public/llms-full.txt" with { type: "file" };
import mdxPlugin from "./lib/bun-mdx-plugin.ts";
import { getDocByPath } from "./lib/docs";
import { getSearchIndexEntries, searchDocs } from "./lib/docs-search";
import { getDocSourceText } from "./lib/docs-server";
import { stripMdxToMarkdown } from "./lib/strip-mdx";

const globalDocsRuntime = globalThis as typeof globalThis & {
  __furinDocsMdxPluginRegistered?: boolean;
};

if (!globalDocsRuntime.__furinDocsMdxPluginRegistered) {
  Bun.plugin(mdxPlugin);
  globalDocsRuntime.__furinDocsMdxPluginRegistered = true;
}

export async function createDocsServer() {
  return (
    new Elysia()
      .get(
        "/llms.txt",
        () =>
          new Response(Bun.file(_llmsTxt), {
            headers: { "Content-Type": "text/markdown; charset=utf-8" },
          })
      )
      .get(
        "/llms-full.txt",
        () =>
          new Response(Bun.file(_llmsFullTxt), {
            headers: { "Content-Type": "text/markdown; charset=utf-8" },
          })
      )
      .get("/docs/llms.txt", () => {
        const doc = getDocByPath("/docs");
        if (!doc) {
          return new Response("Not found", { status: 404 });
        }
        const raw = getDocSourceText(doc.sourcePath);
        const clean = stripMdxToMarkdown(raw);
        return new Response(`# ${doc.title}\n\n> ${doc.description}\n\n${clean}\n`, {
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
      })
      .get("/docs/:slug/llms.txt", ({ params }) => {
        const doc = getDocByPath(`/docs/${params.slug}`);
        if (!doc) {
          return new Response("Not found", { status: 404 });
        }
        const raw = getDocSourceText(doc.sourcePath);
        const clean = stripMdxToMarkdown(raw);
        return new Response(`# ${doc.title}\n\n> ${doc.description}\n\n${clean}\n`, {
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
      })
      // Static JSON used by the client-side search in both dev and static deployments.
      // The same file is pre-generated into public/ by generate:content for static builds.
      .get("/search-entries.json", () => Response.json(getSearchIndexEntries()))
      .get("/api/search", async ({ request }) => {
        const url = new URL(request.url);
        const q = url.searchParams.get("q") ?? "";
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? Number(limitParam) : undefined;

        return {
          query: q,
          results: await searchDocs(q, limit),
        };
      })
      .use(await furin({ pagesDir: "./src/pages" }))
  );
}

const app = await createDocsServer();
app.listen(3000);
console.log(`Furin Docs running at http://localhost:${app.server?.port}`);
