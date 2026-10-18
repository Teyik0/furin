import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AppPrerender } from "../server/prerender.ts";

/**
 * How the child process reaches the built code: an application module that
 * exports the collector, or a packaged app factory that registers its runtime
 * with the host's Furin copy.
 */
export type PrerenderModule = { kind: "app"; path: string } | { kind: "package"; path: string };

function prerenderScript(module: PrerenderModule, render: boolean, resultPath: string): string {
  const href = JSON.stringify(pathToFileURL(module.path).href);
  const collect =
    module.kind === "app"
      ? `const { __furinPrerender: collect } = await import(${href});`
      : `const { createFurinApp } = await import(${href});
await createFurinApp();
const { collectPrerenders: collect } = await import("@teyik0/furin/internal");`;
  return `${collect}
await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(await collect(${render})));
process.exit(0);
`;
}

/**
 * Runs the build-time prerender pass inside the built production code, in a
 * child process, so the build never renders from sources in its own process.
 */
export async function prerenderFromBundle(
  module: PrerenderModule,
  cwd: string,
  render: boolean
): Promise<AppPrerender[]> {
  const resultPath = join(cwd, ".furin", "build", `prerender-${crypto.randomUUID()}.json`);
  const child = Bun.spawn([process.execPath, "-e", prerenderScript(module, render, resultPath)], {
    cwd,
    env: { ...process.env, NODE_ENV: "production" },
    stderr: "pipe",
    stdout: "pipe",
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`[furin] Production prerender failed:\n${stderr}\n${stdout}`);
    }
    return JSON.parse(readFileSync(resultPath, "utf8")) as AppPrerender[];
  } finally {
    rmSync(resultPath, { force: true });
  }
}
