import { compile } from "@mdx-js/mdx";
import remarkGfm from "remark-gfm";
import rehypeShiki from "./rehype-shiki.ts";

const MDX_FILTER = /\.mdx$/;

const mdxPlugin: Bun.BunPlugin = {
  name: "furin-mdx",
  setup(build) {
    build.onLoad({ filter: MDX_FILTER }, async (args) => {
      const source = await Bun.file(args.path).text();
      const compiled = await compile(source, {
        outputFormat: "program",
        development: false,
        remarkPlugins: [remarkGfm],
        rehypePlugins: [rehypeShiki],
      });
      return {
        contents: String(compiled),
        loader: "js",
      };
    });
  },
};

export default mdxPlugin;
