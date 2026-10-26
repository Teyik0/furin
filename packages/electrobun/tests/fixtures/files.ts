import { renameSync, writeFileSync } from "node:fs";

/** Readers must never observe a readiness file before its contents are complete. */
export function publishFixtureFile(path: string, contents: string): void {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  renameSync(temporary, path);
}
