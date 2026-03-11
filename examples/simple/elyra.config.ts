import tailwind from "bun-plugin-tailwind";
import { defineConfig } from "elyra/config";

/**
 * Elyra build config.
 *
 * - `plugins`  — Bun plugins applied to the client bundle at build time.
 *                (Tailwind here: matches the dev bunfig.toml entry for parity)
 * - `client`   — minify / sourcemap options forwarded to Bun.build()
 *
 * pagesDir is intentionally omitted: the build auto-detects it from server.ts
 * via static AST analysis (see scanElyraInstances).
 *
 * Binary compilation (bun run build:split / build:embed) requires a static
 * route manifest to be generated at build time so that all page imports are
 * bundled into the binary. This is tracked as a future milestone — the scripts
 * are available in package.json but disabled here until that work lands.
 */
export default defineConfig({
  plugins: [tailwind],
  client: {
    minify: true,
    sourcemap: false,
  },
});
