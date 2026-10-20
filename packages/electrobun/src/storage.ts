import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import type { RuntimeDataDirectory } from "./config";
import type { DesktopMode } from "./registry";

export interface DataDirectoryContext {
  channel: string;
  env?: NodeJS.ProcessEnv;
  mode: DesktopMode;
  root: string;
}

async function canonical(path: string, api: typeof posix): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const parent = api.dirname(path);
    return parent === path ? path : api.join(await canonical(parent, api), api.basename(path));
  }
}

function within(path: string, root: string, api: typeof posix): boolean {
  const relative = api.relative(root, path);
  return (
    relative === "" ||
    (!api.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${api.sep}`))
  );
}

/** Without a policy, development builds never share the release data directory. */
export function defaultDesktopDataDir(appData: string, identifier: string, channel: string) {
  return join(appData, channel === "dev" ? `${identifier}.dev` : identifier);
}

/** Read-only resolution: no mkdir, migration, data deletion or environment mutation. */
export async function resolveDesktopDataDir(
  policy: string | RuntimeDataDirectory,
  context: DataDirectoryContext
): Promise<string> {
  if (typeof policy === "string") {
    return policy;
  }
  const api = process.platform === "win32" ? win32 : posix;
  const home = homedir();
  const env = context.env ?? process.env;
  const base =
    process.platform === "win32"
      ? (env.APPDATA ?? api.join(home, "AppData/Roaming"))
      : api.join(
          home,
          process.platform === "darwin" ? "Library/Application Support" : ".local/share"
        );
  const development = context.channel === "dev";
  const release = api.resolve(base, policy.name);
  const override = policy.env ? env[policy.env] : undefined;
  const dataDir = api.resolve(
    context.mode === "dev" ? await realpath(context.root) : process.cwd(),
    override ?? api.join(base, development ? policy.developmentName : policy.name)
  );
  if (
    development &&
    (within(dataDir, release, api) ||
      within(await canonical(dataDir, api), await canonical(release, api), api))
  ) {
    throw new Error(
      "Development dataDir is reserved for release; use a separate development directory."
    );
  }
  return dataDir;
}
