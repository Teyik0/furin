import tailwind from "bun-plugin-tailwind";
import { defineConfig } from "furinjs/config";

/**
 * Furin build config.
 * - `plugins`  — Bun plugins applied to the client bundle at build time.
 *                (Tailwind here: matches the dev bunfig.toml entry for parity)
 */
export default defineConfig({
  plugins: [tailwind],
});
