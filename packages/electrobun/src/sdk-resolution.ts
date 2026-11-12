import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import packageManifest from "../package.json" with { type: "json" };

const SUPPORTED_ELECTROBUN = packageManifest.peerDependencies.electrobun;
/** The module the generated bootstrap imports; it must be the SDK's public electrobun/main. */
const MAIN_EXPORT = "./api/sdks/main/index.ts";

/**
 * Resolves the installed Electrobun launcher once. Its version selects the paired runtime, so the
 * launcher and the projected devkit always come from the same release.
 */
export async function resolveSdk(root: string): Promise<{ launcher: string; version: string }> {
  for (const from of [root, import.meta.dir]) {
    let path: string;
    try {
      path = Bun.resolveSync("electrobun/package.json", from);
    } catch {
      // The peer can be resolved from either the consumer or this package.
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: The first resolvable launcher wins.
    const { version }: { version: string } = await Bun.file(path).json();
    if (!Bun.semver.satisfies(version, SUPPORTED_ELECTROBUN)) {
      throw new Error(
        `electrobun ${version} is installed; Furin supports ${SUPPORTED_ELECTROBUN}. Install it with bun add -d electrobun@${SUPPORTED_ELECTROBUN}.`
      );
    }
    return { launcher: join(dirname(path), "bin/electrobun.cjs"), version };
  }
  throw new Error(`Install the desktop SDK with bun add -d electrobun@${SUPPORTED_ELECTROBUN}.`);
}

/** Read Hutch's exact SDK exports; never resolve them through the npm launcher. */
export async function prepareSdkResolution(
  generated: string
): Promise<{ [specifier: string]: string }> {
  const devkit = join(generated, ".hutch/devkit");
  const manifest = Bun.file(join(devkit, "package.json"));
  if (!(await manifest.exists())) {
    return {};
  }
  const { exports }: { exports: { [subpath: string]: string } } = await manifest.json();
  if (exports["./main"] !== MAIN_EXPORT) {
    throw new Error(
      `Electrobun devkit no longer exposes electrobun/main at ${MAIN_EXPORT}; Furin supports electrobun ${SUPPORTED_ELECTROBUN}.`
    );
  }
  const api = join(devkit, "api");
  const aliases = Object.fromEntries(
    Object.entries(exports).map(([subpath, target]) => {
      const path = resolve(devkit, target);
      const child = relative(api, path);
      if (
        (subpath !== "." && !subpath.startsWith("./")) ||
        !target.startsWith("./api/") ||
        child === ".." ||
        child.startsWith(`..${sep}`) ||
        isAbsolute(child)
      ) {
        throw new Error(`Invalid Electrobun devkit export: ${subpath}`);
      }
      return [subpath === "." ? "electrobun" : `electrobun/${subpath.slice(2)}`, path];
    })
  );
  // TypeScript 7 removed baseUrl, which the Electrobun 2.0 devkit tsconfig still sets.
  // Derive only exact paths from the SDK export map, preserving application options.
  await Bun.write(
    join(generated, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          paths: Object.fromEntries(Object.entries(aliases).map(([name, path]) => [name, [path]])),
        },
        // An extending tsconfig replaces `files` and `include` separately, and a
        // config with `files` alone checks nothing else. Both carry the native
        // types, and `include` also covers the project's sources (this file
        // lives in `<project>/.furin/electrobun`, which wildcards skip), so
        // either one surviving keeps the application and its native types checked.
        files: ["native-env.d.ts"],
        include: ["native-env.d.ts", "../../**/*"],
      },
      null,
      2
    )}\n`
  );
  return aliases;
}
