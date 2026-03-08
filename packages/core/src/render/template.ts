// ── Dev template ─────────────────────────────────────────────────────────────

let _devTemplatePromise: Promise<string> | null = null;

export function getDevTemplate(origin: string): Promise<string> {
  _devTemplatePromise ??= fetch(`${origin}/_bun_hmr_entry`)
    .then((r) => {
      if (!r.ok) {
        throw new Error(`/_bun_hmr_entry returned ${r.status}`);
      }
      return r.text();
    })
    .catch((err) => {
      _devTemplatePromise = null;
      throw err;
    });
  return _devTemplatePromise;
}

// ── Prod template ─────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateIndexHtml } from "../build";

// Keyed by the resolved absolute path so different outDirs are cached
// independently and don't clobber each other.
const _prodTemplateCache = new Map<string, string>();

/**
 * Returns the production HTML template.
 * Reads the Bun.build()-processed `.elyra/client/index.html` (which contains
 * content-hashed JS/CSS asset tags) and caches it in memory, keyed by the
 * resolved path so multiple outDir values remain independent.
 * Falls back to the raw `generateIndexHtml()` shell when the file is absent
 * (e.g. in unit tests that run without a prior `bun run build`).
 */
export function readProdTemplate(outDir = ".elyra"): string {
  const path = join(process.cwd(), outDir, "client", "index.html");
  const cached = _prodTemplateCache.get(path);
  if (cached !== undefined) {
    return cached;
  }
  if (existsSync(path)) {
    const template = readFileSync(path, "utf8");
    _prodTemplateCache.set(path, template);
    return template;
  }
  return generateIndexHtml();
}

/** @internal test-only — clears the cached prod templates so tests are isolated. */
export function resetProdTemplate(): void {
  _prodTemplateCache.clear();
}
