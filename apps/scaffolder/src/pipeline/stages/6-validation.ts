import { ScaffolderError } from "../../errors.ts";
import { getProjectRelativePath } from "../../utils/path.ts";
import type { PipelineContext } from "../context.ts";

export async function stage6Validation(ctx: PipelineContext): Promise<void> {
  // ── Check every file actually exists on disk ───────────────────────────
  const existence = await Promise.all(
    ctx.writtenFiles.map(async (filePath) => {
      const exists = await Bun.file(filePath).exists();
      return { exists, filePath };
    })
  );
  const missing = existence.filter(({ exists }) => !exists).map(({ filePath }) => filePath);

  if (missing.length > 0) {
    throw new ScaffolderError(`${missing.length} file(s) were not written:\n${missing.join("\n")}`);
  }

  // ── Validate package.json is parseable JSON ────────────────────────────
  const pkgPath = ctx.writtenFiles.find(
    (filePath) => getProjectRelativePath(ctx.targetDir, filePath) === "package.json"
  );
  if (pkgPath) {
    try {
      const raw = await Bun.file(pkgPath).text();
      JSON.parse(raw);
    } catch (error) {
      throw new ScaffolderError(`Generated package.json is not valid JSON: ${pkgPath}`, {
        cause: error,
      });
    }
  }

  // ── Verify essential Furin files exist ────────────────────────────────
  const essentials = [
    "src/server.ts",
    ctx.routeStyle === "nextjs" ? "src/app/layout.tsx" : "src/routes/__root.tsx",
  ];
  for (const rel of essentials) {
    const exists = ctx.writtenFiles.some(
      (filePath) => getProjectRelativePath(ctx.targetDir, filePath) === rel
    );
    if (!exists) {
      throw new ScaffolderError(
        `Expected file "${rel}" was not generated. Template may be misconfigured.`
      );
    }
  }

  ctx.validationPassed = true;
}
