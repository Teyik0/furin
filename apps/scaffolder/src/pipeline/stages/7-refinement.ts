import { spinner } from "@clack/prompts";
import { ScaffolderError } from "../../errors.ts";
import { initGitRepo } from "../../utils/git.ts";
import type { PipelineContext } from "../context.ts";

export function stage7Refinement(ctx: PipelineContext): void {
  // ── bun install ────────────────────────────────────────────────────────
  if (ctx.install) {
    const s = spinner();
    s.start("Installing dependencies…");

    const result = Bun.spawnSync(["bun", "install"], {
      cwd: ctx.targetDir,
      stderr: "pipe",
      stdout: "pipe",
    });

    if (result.exitCode !== 0) {
      const output = new TextDecoder().decode(result.stderr).trim();
      s.stop("Installation failed.");
      throw new ScaffolderError(`bun install failed${output ? `\n${output}` : ""}`);
    }

    ctx.installRan = true;
    s.stop("Dependencies installed.");
  }

  // ── git init ───────────────────────────────────────────────────────────
  const s = spinner();
  s.start("Initializing git repository…");
  ctx.gitInitRan = initGitRepo(ctx.targetDir);
  s.stop(ctx.gitInitRan ? "Git repository initialized." : "Skipped git init (git not available).");
}
