const TRAILING_SLASHES_RE = /\/+$/;

export function getProjectRelativePath(targetDir: string, filePath: string): string {
  const normalizedTargetDir = normalizePath(targetDir).replace(TRAILING_SLASHES_RE, "");
  const normalizedFilePath = normalizePath(filePath);

  if (normalizedFilePath === normalizedTargetDir) {
    return "";
  }

  if (normalizedFilePath.startsWith(`${normalizedTargetDir}/`)) {
    return normalizedFilePath.slice(normalizedTargetDir.length + 1);
  }

  return normalizedFilePath;
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}
