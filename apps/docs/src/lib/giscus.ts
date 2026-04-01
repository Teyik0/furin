import type { Theme } from "@/components/theme-provider";

export interface GiscusConfig {
  category: string | undefined;
  categoryId: string | undefined;
  emitMetadata: string;
  inputPosition: string;
  lang: string;
  mapping: string;
  reactionsEnabled: string;
  repo: string | undefined;
  repoId: string | undefined;
  strict: string;
}

const DEFAULT_GISCUS_CONFIG = {
  emitMetadata: "0",
  inputPosition: "bottom",
  lang: "en",
  mapping: "pathname",
  reactionsEnabled: "0",
  strict: "1",
} satisfies Pick<
  GiscusConfig,
  "emitMetadata" | "inputPosition" | "lang" | "mapping" | "reactionsEnabled" | "strict"
>;

export function getGiscusConfig(): GiscusConfig {
  return {
    repo: "teyik0/furin",
    repoId: "R_kgDORRsvuw",
    category: "Q&A",
    categoryId: "DIC_kwDORRsvu84C5bWC",
    mapping: DEFAULT_GISCUS_CONFIG.mapping,
    strict: DEFAULT_GISCUS_CONFIG.strict,
    reactionsEnabled: DEFAULT_GISCUS_CONFIG.reactionsEnabled,
    emitMetadata: DEFAULT_GISCUS_CONFIG.emitMetadata,
    inputPosition: DEFAULT_GISCUS_CONFIG.inputPosition,
    lang: DEFAULT_GISCUS_CONFIG.lang,
  };
}

export function getMissingGiscusConfigFields(config: GiscusConfig): string[] {
  const fields: [string, string | undefined][] = [
    ["repo", config.repo],
    ["repoId", config.repoId],
    ["category", config.category],
    ["categoryId", config.categoryId],
  ];

  return fields.filter(([, value]) => !value).map(([field]) => field);
}

export function getGiscusTheme(theme: Theme): string {
  return theme === "dark" ? "transparent_dark" : "light";
}
