const REGEX_SPECIAL_CHARACTERS_RE = /[.*+?^${}()|[\]\\]/g;

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
  const entrypointFilter = new RegExp(
    `^${entrypoint.replace(REGEX_SPECIAL_CHARACTERS_RE, "\\$&")}$`
  );
  return {
    entrypoint,
    files: { [entrypoint]: source },
    plugin: {
      name: `furin-virtual-entry:${entrypoint}`,
      setup(build) {
        build.onLoad({ filter: entrypointFilter }, () => ({ contents: source, loader }));
      },
    },
  };
}
