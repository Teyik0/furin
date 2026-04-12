import { cancel, isCancel, select } from "@clack/prompts";
import type { ManifestRegistry, PipelineContext, TemplateId } from "../context.ts";
import { TEMPLATES_DIR } from "../context.ts";

let cachedManifest: ManifestRegistry | null = null;

async function loadManifest(): Promise<ManifestRegistry> {
  if (cachedManifest) {
    return cachedManifest;
  }
  const manifestPath = `${TEMPLATES_DIR}/manifest.json`;
  const raw = await Bun.file(manifestPath).text();
  cachedManifest = JSON.parse(raw) as ManifestRegistry;
  return cachedManifest;
}

export async function stage2Selection(ctx: PipelineContext): Promise<void> {
  const registry = await loadManifest();

  // ── Template selection ─────────────────────────────────────────────────
  if (!ctx.templateId) {
    const chosen = await select({
      message: "Which template would you like to use?",
      options: registry.templates.map((t) => ({
        value: t.id as TemplateId,
        label: t.label,
        hint: t.description,
      })),
    });

    if (isCancel(chosen)) {
      cancel("Scaffolding cancelled.");
      process.exit(0);
    }

    ctx.templateId = chosen as TemplateId;
  }

  const template = registry.templates.find((t) => t.id === ctx.templateId);
  if (!template) {
    throw new Error(`Template "${ctx.templateId}" not found in manifest.`);
  }

  ctx.manifest = template;
  ctx.features = template.features;
}
