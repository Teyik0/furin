import { existsSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { ensureDir } from "./shared.ts";

/** Keep server maps out of Bun assets and Vercel's deployment artifact. */
export function movePrivateServerSourceMaps(
  outputDir: string,
  privateDir: string,
  filenames: readonly string[]
): void {
  for (const filename of filenames) {
    const source = isAbsolute(filename) ? filename : join(outputDir, filename);
    if (!existsSync(source)) {
      continue;
    }
    const destination = join(privateDir, relative(outputDir, source));
    ensureDir(dirname(destination));
    renameSync(source, destination);
  }
}
