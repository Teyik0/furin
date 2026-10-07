import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isPackageName } from "./package-name";

interface DependencyManifest {
  dependencies?: { [name: string]: string };
  optionalDependencies?: { [name: string]: string };
  peerDependencies?: { [name: string]: string };
  peerDependenciesMeta?: { [name: string]: { optional?: boolean } };
}

function findPackage(from: string, name: string): string | undefined {
  if (!isPackageName(name)) {
    throw new Error(`Invalid external package name: "${name}".`);
  }
  let current: string | undefined = from;
  while (current) {
    const candidate = join(current, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }
    const parent = dirname(current);
    current = parent === current ? undefined : parent;
  }
}

function findInstalled(
  installed: Map<string, string>,
  from: string,
  name: string
): string | undefined {
  let current: string | undefined = from;
  while (current) {
    const source = installed.get(join(current, "node_modules", name));
    if (source) {
      return source;
    }
    const parent = dirname(current);
    current = parent === current ? undefined : parent;
  }
}

async function copyPackage(
  source: string,
  target: string,
  packageRoot: string,
  ancestors: Set<string>
): Promise<void> {
  const real = realpathSync(source);
  const offset = relative(packageRoot, real);
  if (isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`)) {
    throw new Error(`External package asset escapes its package: ${source}`);
  }
  if (offset.split(sep).includes("node_modules")) {
    throw new Error(`External package asset points into source node_modules: ${source}`);
  }
  if (ancestors.has(real)) {
    throw new Error(`External package asset contains a directory cycle: ${source}`);
  }
  if ((await stat(real)).isDirectory()) {
    await mkdir(target, { recursive: true });
    const next = new Set([...ancestors, real]);
    await Promise.all(
      (await readdir(real))
        .filter((name) => name !== "node_modules")
        .map((name) => copyPackage(join(real, name), join(target, name), packageRoot, next))
    );
  } else {
    await cp(real, target);
  }
}

/** Copy only declared runtime closures as archive-safe, Node-resolvable trees. */
export async function copyExternalPackages(
  root: string,
  output: string,
  names: string[]
): Promise<void> {
  // Validate the entire runtime closure before creating or overwriting output.
  const checked = new Set<string>();
  const importNames = new Set(names);
  const preflight = async (source: string): Promise<void> => {
    if (checked.has(source)) {
      return;
    }
    checked.add(source);
    const manifest: DependencyManifest = JSON.parse(
      await readFile(join(source, "package.json"), "utf8")
    );
    await Promise.all(
      Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      }).map(async (name) => {
        importNames.add(name);
        const resolved = findPackage(source, name);
        if (resolved) {
          await preflight(resolved);
        }
      })
    );
  };
  await Promise.all(
    names.map(async (name) => {
      const source = findPackage(root, name);
      if (source) {
        await preflight(source);
      }
    })
  );
  const installed = new Map<string, string>();
  const active = new Set<string>();
  const visit = async (source: string, target: string, importName: string): Promise<void> => {
    installed.set(target, source);
    // Repeating a source is finite when a different ancestor environment resolves its closure.
    const identity = JSON.stringify([
      source,
      importName,
      [...importNames].map((name) => findInstalled(installed, target, name) ?? null),
    ]);
    if (active.has(identity)) {
      throw new Error(
        `Cannot materialize external dependency cycle for "${importName}": conflicting package versions shadow its ancestor.`
      );
    }
    active.add(identity);
    await mkdir(dirname(target), { recursive: true });
    await copyPackage(source, target, source, new Set());
    const manifest: DependencyManifest = JSON.parse(
      await readFile(join(source, "package.json"), "utf8")
    );
    const required = new Set(Object.keys(manifest.dependencies ?? {}));
    const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}));
    const peers = Object.keys(manifest.peerDependencies ?? {});
    for (const name of new Set([...required, ...optional, ...peers])) {
      const resolved = findPackage(source, name);
      if (!resolved) {
        if (optional.has(name) || manifest.peerDependenciesMeta?.[name]?.optional) {
          continue;
        }
        throw new Error(
          `Missing external dependency "${name}" required by ${source}. Install it with Bun first.`
        );
      }
      if (findInstalled(installed, target, name) !== resolved) {
        // biome-ignore lint/performance/noAwaitInLoops: Resolution depends on the ancestor graph registered by prior visits.
        await visit(resolved, join(target, "node_modules", name), name);
      }
    }
    active.delete(identity);
  };
  for (const name of new Set(names)) {
    const source = findPackage(root, name);
    if (!source) {
      throw new Error(`External package "${name}" is not installed in ${root}.`);
    }
    // biome-ignore lint/performance/noAwaitInLoops: Root packages participate in the same ordered resolution graph.
    await visit(source, join(output, "node_modules", name), name);
  }
}
