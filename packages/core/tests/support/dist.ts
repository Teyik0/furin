import { statSync } from "node:fs";
import { join, resolve } from "node:path";

const CORE_DIR = resolve(import.meta.dir, "../..");

/**
 * Throws when `dist/<entry>` is missing or older than any file in `src/`, so
 * tests of the published build never silently run against stale output.
 */
export function assertDistFresh(entry: string): void {
  const distPath = join(CORE_DIR, "dist", entry);
  let builtAt: number;
  try {
    builtAt = statSync(distPath).mtimeMs;
  } catch (error) {
    throw new Error(`${distPath} is missing. Run \`bun run build\` in packages/core first.`, {
      cause: error,
    });
  }
  for (const file of new Bun.Glob("**/*").scanSync({ cwd: join(CORE_DIR, "src") })) {
    if (statSync(join(CORE_DIR, "src", file)).mtimeMs > builtAt) {
      throw new Error(
        `dist/ is older than src/${file}. Run \`bun run build\` in packages/core first.`
      );
    }
  }
}
