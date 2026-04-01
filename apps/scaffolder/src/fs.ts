import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { TemplateTokens } from "./template-tokens.ts";

export async function copyTemplateDirectory(
  templateDir: string,
  targetDir: string,
  tokens: TemplateTokens
): Promise<void> {
  await copyDirectory(templateDir, targetDir, templateDir, tokens);
}

function replaceTokens(contents: string, tokens: TemplateTokens): string {
  let result = contents;

  for (const [token, value] of Object.entries(tokens.replacements)) {
    result = result.replaceAll(token, value);
  }

  return result;
}

async function copyDirectory(
  currentDir: string,
  targetDir: string,
  templateRoot: string,
  tokens: TemplateTokens
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = join(currentDir, entry.name);
    const relativePath = relative(templateRoot, sourcePath);
    const targetPath = join(targetDir, relativePath);

    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await copyDirectory(sourcePath, targetDir, templateRoot, tokens);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    await mkdir(dirname(targetPath), { recursive: true });
    const contents = await readFile(sourcePath, "utf8");
    await writeFile(targetPath, replaceTokens(contents, tokens), "utf8");
  }
}
