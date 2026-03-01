import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

let _prodTemplate: string | null = null;

/**
 * Reads the production SSR template from disk once and caches it.
 * The template is .elysion/client/index.html produced by buildClient().
 */
export function getProdTemplate(): string {
  if (_prodTemplate !== null) {
    return _prodTemplate;
  }
  const templatePath = resolve(process.cwd(), ".elysion", "client", "index.html");
  _prodTemplate = readFileSync(templatePath, "utf8");
  return _prodTemplate;
}

/** Override the prod template (used in tests to avoid disk reads). */
export function _setProdTemplate(template: string): void {
  _prodTemplate = template;
}
