/**
 * Pre-start generator for Elysion dev mode.
 *
 * Scans the pages directory and writes:
 *   .elysion/_hydrate.tsx  — client hydration entry (re-generated each run)
 *   .elysion/index.html    — fixed SSR template (only written if missing/stale)
 *
 * Run this before starting the dev server:
 *   bun run scripts/generate.ts && bun --hot src/server.ts
 *
 * This is needed because `server.ts` statically imports `.elysion/index.html`,
 * which must exist (along with `_hydrate.tsx`) before Bun evaluates the module.
 */
import { writeDevFiles } from "@teyik0/elysion/build";
import { scanPages } from "@teyik0/elysion/router";

const pagesDir = `${import.meta.dir}/../src/pages`;
const outDir = `${import.meta.dir}/../.elysion`;

const { routes, root } = await scanPages(pagesDir, true);
writeDevFiles(routes, { outDir, rootPath: root?.path ?? null });

console.log("[elysion] Generation complete. Starting dev server...");
