import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadCliConfig } from "./config";

const PORT = /^\d+$/;

export async function runDevelopment(cwd: string, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args: args.filter((arg) => arg !== "--"),
    options: { web: { type: "boolean" }, desktop: { type: "boolean" }, port: { type: "string" } },
    strict: true,
  });
  if (values.web && values.desktop) {
    throw new Error("Choose --web or --desktop, not both.");
  }
  const config = await loadCliConfig(cwd);
  const hasDesktop = "desktop" in config && config.desktop !== undefined;
  if (hasDesktop && !values.web) {
    if (values.port !== undefined) {
      throw new Error("--port is only available with --web.");
    }
    let entry: string;
    try {
      entry = Bun.resolveSync("@teyik0/furin-electrobun/dev", cwd);
    } catch (cause) {
      throw new Error("Install @teyik0/furin-electrobun to run this desktop configuration.", {
        cause,
      });
    }
    const addon: { runDesktopDevelopment: (cwd: string, openBrowser: boolean) => Promise<void> } =
      await import(pathToFileURL(entry).href);
    await addon.runDesktopDevelopment(cwd, !values.desktop);
    return;
  }
  if (values.desktop) {
    throw new Error("Add desktop to furin.config.ts before using --desktop.");
  }
  const port = values.port ?? process.env.PORT ?? "3000";
  if (!PORT.test(port) || Number(port) > 65_535) {
    throw new Error("Invalid development port.");
  }
  const child = Bun.spawn(
    [
      process.execPath,
      "--hot",
      join(import.meta.dir, "dev-worker.ts"),
      resolve(config.rootDir, config.serverEntry ?? "src/server.ts"),
      port,
    ],
    {
      cwd: config.rootDir,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      ipc: () => undefined,
    }
  );
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (deadline) {
      return;
    }
    child.send("stop");
    // Bound cancellation even if consumer code prevents the worker's own timer.
    deadline = setTimeout(() => child.kill("SIGKILL"), 6000);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const code = await child.exited;
    if (code !== 0) {
      throw new Error(`Development server exited (${code}).`);
    }
  } finally {
    clearTimeout(deadline);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
}
