import { escapeRegExp } from "../server/router/patterns.ts";

export interface VirtualBuildEntry {
  entrypoint: string;
  files: { [path: string]: string };
  plugin: Bun.BunPlugin;
}

export function createVirtualBuildEntry(
  entrypoint: string,
  source: string,
  loader: Bun.Loader
): VirtualBuildEntry {
  const normalizedEntrypoint = entrypoint.replaceAll("\\", "/");
  const entrypointFilter = new RegExp(`^${escapeRegExp(normalizedEntrypoint)}$`);
  return {
    entrypoint: normalizedEntrypoint,
    files: { [normalizedEntrypoint]: source },
    plugin: {
      name: `furin-virtual-entry:${normalizedEntrypoint}`,
      setup(build) {
        build.onLoad({ filter: entrypointFilter }, () => ({ contents: source, loader }));
      },
    },
  };
}
