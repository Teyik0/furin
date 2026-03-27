// ── Dev template ─────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

let _prodTemplatePath: string | null = null;
let _prodTemplateContent: string | null = null;

export async function getDevTemplate(origin: string): Promise<string> {
  const r = await fetch(`${origin}/_bun_hmr_entry`);
  if (!r.ok) {
    throw new Error(`/_bun_hmr_entry returned ${r.status}`);
  }
  return r.text();
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
