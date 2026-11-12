import { cancel, isCancel, select } from "@clack/prompts";
import type { ManifestRegistry, PipelineContext, RouteStyle, TemplateId } from "../context.ts";
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
        hint: t.description,
        label: t.label,
        value: t.id as TemplateId,
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

  // ── Routing style selection ────────────────────────────────────────────
  if (!ctx.routeStyle) {
    const style = await select({
      message: "Which file-routing style?",
      options: [
        {
          hint: "__root.tsx, route.tsx, $id.tsx, posts.$id.tsx",
          label: "TanStack Start",
          value: "tanstack" as RouteStyle,
        },
        {
          hint: "layout.tsx, page.tsx, [id]/page.tsx",
          label: "Next.js App Router",
          value: "nextjs" as RouteStyle,
        },
      ],
    });

    if (isCancel(style)) {
      cancel("Scaffolding cancelled.");
      process.exit(0);
    }

    ctx.routeStyle = style as RouteStyle;
  }
}
