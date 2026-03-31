import { resolve } from "node:path";

export interface TemplateDefinition {
  description: string;
  id: "minimal" | "shadcn";
  label: string;
  templateDir: string;
}

export const templates: readonly TemplateDefinition[] = [
  {
    id: "minimal",
    label: "Minimal",
    description: "Tailwind + API hello world + loader SSR",
    templateDir: resolve(import.meta.dir, "../templates/minimal"),
  },
  {
    id: "shadcn",
    label: "shadcn",
    description: "Tailwind + shadcn setup + API hello world + loader SSR",
    templateDir: resolve(import.meta.dir, "../templates/shadcn"),
  },
] as const;

export function getTemplate(id: string): TemplateDefinition {
  const template = templates.find((entry) => entry.id === id);
  if (!template) {
    throw new Error(`Unknown template "${id}"`);
  }
  return template;
}
