import { defineConfig } from "@teyik0/furin/config";
import tailwind from "bun-plugin-tailwind";
import mdxPlugin from "./src/lib/bun-mdx-plugin";

/**
 * Furin build config.
 * - `plugins`  — Bun plugins applied to the client bundle at build time.
 *                (Tailwind here: matches the dev bunfig.toml entry for parity)
 * - `static`   — GitHub Pages static export config.
 *                Set basePath to the GitHub repo name (e.g. "/elysion" for
 *                user.github.io/elysion/) and outDir to "dist".
 */
export default defineConfig({
  plugins: [tailwind, mdxPlugin],
  static: {
    basePath: "/furin",
    outDir: "dist",
  },
});
