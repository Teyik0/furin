import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadCliConfig } from "./config";

const PORT = /^\d+$/;

/** The hot worker serves the backend; the desktop integration owns the native shell. */
async function desktopIntegration(cwd: string, openBrowser: boolean) {
  let entry: string;
  let integration: string;
  try {
    entry = Bun.resolveSync("@teyik0/furin-electrobun/dev", cwd);
    integration = Bun.resolveSync("@teyik0/furin-electrobun/desktop-dev", cwd);
  } catch (cause) {
    throw new Error("Install @teyik0/furin-electrobun to run this desktop configuration.", {
      cause,
    });
  }
  const addon: {
    prepareDesktopDevelopment: (
      cwd: string,
      openBrowser: boolean
    ) => Promise<{ [name: string]: string }>;
  } = await import(pathToFileURL(entry).href);
  return { integration, env: await addon.prepareDesktopDevelopment(cwd, openBrowser) };
}

function webIntegration(cwd: string): { integration: string; env: { [name: string]: string } } {
  try {
    return { integration: Bun.resolveSync("@teyik0/furin-electrobun/web-dev", cwd), env: {} };
  } catch {
    // Web-only apps can run without the optional desktop integration installed.
    return { integration: "", env: {} };
  }
}

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
  const hasDesktop = config.desktop !== undefined;
  if (values.desktop && !hasDesktop) {
    throw new Error("Add desktop to furin.config.ts before using --desktop.");
  }
  const desktop = hasDesktop && !values.web;
  if (desktop && values.port !== undefined) {
    throw new Error("--port is only available with --web.");
  }
  const port = desktop ? undefined : (values.port ?? process.env.PORT);
  if (port !== undefined && (!PORT.test(port) || Number(port) > 65_535)) {
    throw new Error("Invalid development port.");
  }
  const { integration, env } = desktop
    ? await desktopIntegration(cwd, !values.desktop)
    : webIntegration(cwd);
  const child = Bun.spawn(
    [
      process.execPath,
      "--hot",
      join(import.meta.dir, "dev-worker.ts"),
      resolve(config.rootDir, config.serverEntry ?? "src/server.ts"),
      port ?? "",
      integration,
    ],
    {
      cwd: config.rootDir,
      env: { ...process.env, ...env },
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
