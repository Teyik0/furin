// ── HTML template state (per furin instance) ────────────────────────────────

import { readFileSync } from "node:fs";
import type { DocumentAssets } from "../../client/document.tsx";
import { injectInstrumentationClient } from "../devtools/instrumentation.ts";
import {
  allStateBuckets,
  currentInstance,
  defaultInstanceBucket,
  type FurinInstance,
  instanceSlot,
} from "../instance.ts";

interface TemplateState {
  devAssets: { assets: DocumentAssets; ts: number } | null;
  devCache: { html: string; ts: number } | null;
  prodAssets: DocumentAssets | null;
  prodContent: string | null;
  prodPath: string | null;
}

const instanceTemplateState = instanceSlot(
  (): TemplateState => ({
    devAssets: null,
    devCache: null,
    prodAssets: null,
    prodContent: null,
    prodPath: null,
  })
);

const DEV_TEMPLATE_TTL_MS = 1000;
const TAG_ATTRIBUTE_PATTERN = /([A-Za-z][\w:-]*)="([^"]*)"/g;
const BUILD_ID_META_PATTERN = /<meta\s+name="furin-build-id"\s+content="([^"]+)"\s*>/;

function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(TAG_ATTRIBUTE_PATTERN)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) {
      attributes.set(name.toLowerCase(), value);
    }
  }
  return attributes;
}

export function documentAssetsFromTemplate(template: string): DocumentAssets {
  const stylesheets: string[] = [];
  let faviconHref: string | undefined;
  for (const tag of template.match(/<link\b[^>]*>/g) ?? []) {
    const attributes = attributesOf(tag);
    const rel = attributes.get("rel");
    const href = attributes.get("href");
    if (rel === "stylesheet" && href !== undefined) {
      stylesheets.push(href);
    } else if (rel === "icon") {
      faviconHref = href;
    }
  }

  let entryModule: string | undefined;
  for (const tag of template.match(/<script\b[^>]*>/g) ?? []) {
    const attributes = attributesOf(tag);
    if (attributes.get("type") === "module" && attributes.has("src")) {
      entryModule = attributes.get("src");
      if (tag.includes("data-bun-dev-server-script")) {
        break;
      }
    }
  }

  return {
    buildId: template.match(BUILD_ID_META_PATTERN)?.[1],
    entryModule,
    faviconHref,
    staticMode: template.includes('<meta name="furin-mode" content="static">'),
    stylesheets,
  };
}

export async function getDevTemplate(origin: string): Promise<string> {
  const instance = currentInstance();
  const state = instanceTemplateState(instance);
  if (state.devCache && Date.now() - state.devCache.ts < DEV_TEMPLATE_TTL_MS) {
    return state.devCache.html;
  }
  // Each instance's HMR entry is mounted under its own prefix.
  const entryPath = `${instance.prefix}/_bun_hmr_entry`;
  const r = await fetch(`${origin}${entryPath}`);
  if (!r.ok) {
    throw new Error(`${entryPath} returned ${r.status}`);
  }
  const html = injectInstrumentationClient(await r.text(), instance.prefix);
  state.devCache = { html, ts: Date.now() };
  return html;
}

export async function getDevDocumentAssets(origin: string): Promise<DocumentAssets> {
  const state = instanceTemplateState();
  if (state.devAssets && Date.now() - state.devAssets.ts < DEV_TEMPLATE_TTL_MS) {
    return state.devAssets.assets;
  }
  const assets = documentAssetsFromTemplate(await getDevTemplate(origin));
  state.devAssets = { assets, ts: Date.now() };
  return assets;
}

export function setProductionTemplatePath(path: string | null, instance?: FurinInstance): void {
  const state = instanceTemplateState(instance);
  state.prodPath = path;
  state.prodAssets = null;
  state.prodContent = null;
}

export function setProductionTemplateContent(content: string, instance?: FurinInstance): void {
  const state = instanceTemplateState(instance);
  state.prodPath = null;
  state.prodContent = content;
  state.prodAssets = documentAssetsFromTemplate(content);
}

export function getProductionDocumentAssets(): DocumentAssets | null {
  const own = readDocumentAssets(instanceTemplateState());
  if (own !== null) {
    return own;
  }
  return readDocumentAssets(instanceTemplateState(defaultInstanceBucket()));
}

export function getProductionTemplate(): string | null {
  const own = readTemplate(instanceTemplateState());
  if (own !== null) {
    return own;
  }
  // Config-before-mount fallback: `setProductionTemplateContent()` called
  // before any furin() registration lands on the default bucket — treat that
  // as a process-wide default template.
  const fallback = instanceTemplateState(defaultInstanceBucket());
  return readTemplate(fallback);
}

function readTemplate(state: TemplateState): string | null {
  if (state.prodContent !== null) {
    return state.prodContent;
  }
  if (!state.prodPath) {
    return null;
  }
  try {
    state.prodContent = readFileSync(state.prodPath, "utf8");
    return state.prodContent;
  } catch {
    return null;
  }
}

function readDocumentAssets(state: TemplateState): DocumentAssets | null {
  if (state.prodAssets !== null) {
    return state.prodAssets;
  }
  const template = readTemplate(state);
  if (template === null) {
    return null;
  }
  state.prodAssets = documentAssetsFromTemplate(template);
  return state.prodAssets;
}

/** @internal test-only — resets all template state */
export function __resetTemplateState(): void {
  for (const instance of allStateBuckets()) {
    const state = instanceTemplateState(instance);
    state.devAssets = null;
    state.devCache = null;
    state.prodAssets = null;
    state.prodContent = null;
    state.prodPath = null;
  }
}
