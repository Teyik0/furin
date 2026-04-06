import type { PackageCatalog } from "../../package-catalog.ts";
import { getPackageCatalog } from "../../package-catalog.ts";
import type { PipelineContext } from "../context.ts";

type TokenMap = Record<string, string>;

/**
 * Fetches the latest published version of a package from the npm registry.
 * Returns null on network error or unexpected response — caller should fallback.
 */
async function fetchLatestVersion(packageName: string): Promise<string | null> {
  try {
    const encoded = packageName.replace("/", "%2F");
    const res = await fetch(`https://registry.npmjs.org/${encoded}/latest`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return null;
    }
    const { version } = (await res.json()) as { version: string };
    return typeof version === "string" ? `^${version}` : null;
  } catch {
    return null;
  }
}

function buildTokenMap(catalog: PackageCatalog, furinVersion: string): TokenMap {
  return {
    "{{FURIN_VERSION}}": furinVersion,
    "{{ELYSIA_VERSION}}": catalog.elysia,
    "{{EVLOG_VERSION}}": catalog.evlog,
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
    "{{RADIX_UI_SLOT_VERSION}}": catalog["@radix-ui/react-slot"],
    "{{LUCIDE_REACT_VERSION}}": catalog["lucide-react"],
    "{{TW_ANIMATE_VERSION}}": catalog["tw-animate-css"],
  };
}

function resolveVersions(deps: Record<string, string>, tokenMap: TokenMap): Record<string, string> {
  return Object.fromEntries(
    Object.entries(deps).map(([name, version]) => [name, tokenMap[version] ?? version])
  );
}

export async function stage4Deps(ctx: PipelineContext): Promise<void> {
  if (!ctx.manifest) {
    throw new Error("Manifest not loaded — stage2Selection must run first.");
  }

  const catalog = getPackageCatalog();

  // Fetch the latest published version of @teyik0/furin from npm.
  // Fall back to the pinned catalog version if the registry is unreachable.
  const liveVersion = await fetchLatestVersion("@teyik0/furin");
  const furinVersion = liveVersion ?? catalog["@teyik0/furin"];

  // Expose on context so Stage 1 and the EJS vars can reference it.
  ctx.furinVersion = furinVersion;

  const tokenMap = buildTokenMap(catalog, furinVersion);

  ctx.dependencies = resolveVersions(ctx.manifest.dependencies, tokenMap);
  ctx.devDependencies = resolveVersions(ctx.manifest.devDependencies, tokenMap);
}
