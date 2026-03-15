// ── Dev template ─────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

const devTemplatePromises = new Map<string, Promise<string>>();
let _prodTemplatePath: string | null = null;
let _prodTemplateContent: string | null = null;

export function getDevTemplate(origin: string): Promise<string> {
  const cached = devTemplatePromises.get(origin);
  if (cached) {
    return cached;
  }

  const promise = fetch(`${origin}/_bun_hmr_entry`)
    .then((r) => {
      if (!r.ok) {
        throw new Error(`/_bun_hmr_entry returned ${r.status}`);
      }
      return r.text();
    })
    .catch((err) => {
      devTemplatePromises.delete(origin);
      throw err;
    });

  devTemplatePromises.set(origin, promise);
  return promise;
}

export function setProductionTemplatePath(path: string | null): void {
  _prodTemplatePath = path;
  _prodTemplateContent = null;
}

export function setProductionTemplateContent(content: string): void {
  _prodTemplatePath = null;
  _prodTemplateContent = content;
}

export function getProductionTemplate(): string | null {
  if (_prodTemplateContent !== null) {
    return _prodTemplateContent;
  }
  if (!_prodTemplatePath) {
    return null;
  }
  try {
    _prodTemplateContent = readFileSync(_prodTemplatePath, "utf8");
    return _prodTemplateContent;
  } catch {
    return null;
  }
}
