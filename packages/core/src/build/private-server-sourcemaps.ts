import { existsSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { ensureDir } from "./shared.ts";

/** Keep server maps out of Bun assets and Vercel's deployment artifact. */
export function movePrivateServerSourceMaps(
  outputDir: string,
  privateDir: string,
  filenames: readonly string[]
): void {
  for (const filename of filenames) {
    const name = basename(filename);
    const source = join(outputDir, name);
    if (!existsSync(source)) {
      continue;
    }
    ensureDir(privateDir);
    renameSync(source, join(privateDir, name));
  }
}
