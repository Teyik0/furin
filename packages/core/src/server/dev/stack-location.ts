import { fileURLToPath } from "node:url";
import type { DevSourceLocation } from "../../shared/dev-diagnostics.ts";

const STACK_POSITION_RE = /(?:^|\s)\(?((?:file:\/\/)?\S+):(\d+):(\d+)\)?$/;
const DEV_PAGE_PREFIX_RE = /^furin-dev-(?:page|render):/;
const QUERY_RE = /\?.*$/;

/** Local path of a `file://` URL; other paths, or URLs that cannot be projected, are kept. */
export function sourceFilePath(file: string): string {
  if (!file.startsWith("file://")) {
    return file;
  }
  try {
    return fileURLToPath(file);
  } catch {
    return file;
  }
}

/**
 * Source location of a server stack: the first frame in `entryPath`, else the
 * first positioned frame. Dev page specifiers (`furin-dev-page:`) and query
 * strings are stripped so the location names the application file.
 */
export function stackSourceLocation(
  stack: string | undefined,
  entryPath: string
): DevSourceLocation | undefined {
  if (!stack) {
    return;
  }
  const locations: DevSourceLocation[] = [];
  for (const line of stack.split("\n")) {
    const match = STACK_POSITION_RE.exec(line.trim());
    // biome-ignore lint/suspicious/noUnnecessaryConditions: stack lines need not match the position pattern.
    if (!(match?.[1] && match[2] && match[3])) {
      continue;
    }
    locations.push({
      column: Number.parseInt(match[3], 10),
      file: sourceFilePath(match[1].replace(DEV_PAGE_PREFIX_RE, "").replace(QUERY_RE, "")),
      line: Number.parseInt(match[2], 10),
    });
  }
  return locations.find((location) => location.file === entryPath) ?? locations[0];
}
