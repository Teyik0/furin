import { ScaffolderError } from "./errors.ts";

export function runBunInstall(targetDir: string): void {
  const result = Bun.spawnSync(["bun", "install"], {
    cwd: targetDir,
    stderr: "pipe",
    stdout: "pipe",
  });

  if (result.exitCode !== 0) {
    const output =
      `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`.trim();
    throw new ScaffolderError(`bun install failed${output ? `\n${output}` : ""}`);
  }
}
