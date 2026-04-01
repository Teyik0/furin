import { basename } from "node:path";
import { getPackageCatalog } from "./package-catalog.ts";
import { normalizePackageName } from "./validate.ts";

export interface TemplateTokens {
  furinVersion: string;
  packageName: string;
  projectName: string;
  replacements: Record<string, string>;
}

export function buildTemplateTokens(targetDir: string): TemplateTokens {
  const projectName = basename(targetDir);
  const packageName = normalizePackageName(projectName);
  const catalog = getPackageCatalog();

  return {
    packageName,
    projectName,
    furinVersion: catalog["@teyik0/furin"],
    replacements: {
      "{{PACKAGE_NAME}}": packageName,
      "{{PROJECT_NAME}}": projectName,
      "{{FURIN_VERSION}}": catalog["@teyik0/furin"],
      "{{ELYSIA_VERSION}}": catalog.elysia,
      "{{REACT_VERSION}}": catalog.react,
      "{{REACT_DOM_VERSION}}": catalog["react-dom"],
      "{{TYPES_REACT_VERSION}}": catalog["@types/react"],
      "{{TYPES_REACT_DOM_VERSION}}": catalog["@types/react-dom"],
      "{{TYPES_BUN_VERSION}}": catalog["@types/bun"],
      "{{TYPESCRIPT_VERSION}}": catalog.typescript,
      "{{BUN_PLUGIN_TAILWIND_VERSION}}": catalog["bun-plugin-tailwind"],
      "{{TAILWIND_VERSION}}": catalog.tailwindcss,
      "{{CVA_VERSION}}": catalog["class-variance-authority"],
      "{{CLSX_VERSION}}": catalog.clsx,
      "{{TAILWIND_MERGE_VERSION}}": catalog["tailwind-merge"],
      "{{RADIX_UI_VERSION}}": catalog["radix-ui"],
      "{{LUCIDE_REACT_VERSION}}": catalog["lucide-react"],
      "{{TW_ANIMATE_VERSION}}": catalog["tw-animate-css"],
    },
  };
}
