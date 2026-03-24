import { furin } from "@teyik0/furin";
import { Elysia } from "elysia";
import { api } from "./api/index.ts";
import mdxPlugin from "./lib/bun-mdx-plugin.ts";

Bun.plugin(mdxPlugin);

const app = new Elysia()
  .use(api)
  .use(
    await furin({
      pagesDir: "./src/pages",
      logger: {
        browser: true,
      },
    })
  )
  .listen(3000);

console.log(`\nFurin Docs running at http://localhost:${app.server?.port}`);
console.log("Initial cold start: ", performance.now().toFixed(2), "ms");
