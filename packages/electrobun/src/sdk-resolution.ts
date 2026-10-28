import { isAbsolute, join, relative, resolve, sep } from "node:path";

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
  // TypeScript 7 removed baseUrl, which Electrobun 2.0.5's tsconfig still sets.
  // Derive only exact paths from the SDK export map, preserving application options.
  await Bun.write(
    join(generated, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          paths: Object.fromEntries(Object.entries(aliases).map(([name, path]) => [name, [path]])),
        },
      },
      null,
      2
    )}\n`
  );
  return aliases;
}
