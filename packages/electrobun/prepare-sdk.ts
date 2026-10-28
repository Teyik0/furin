import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prepareSdkResolution } from "./src/sdk-resolution";

/** Package development uses the same pinned, original devkit as consumer projects. */
const root = join(import.meta.dir, ".furin/sdk");
await mkdir(root, { recursive: true });
await Bun.write(join(root, "package.json"), '{"private":true,"type":"module"}\n');
await Bun.write(
  join(root, "hutch.config.ts"),
  'export default { electrobun: { version: "2.0.5" } };\n'
);
await Bun.write(
  join(root, "electrobun.config.ts"),
  'export default { app: { name: "Furin SDK Types", identifier: "local.furin.sdk-types", version: "0.0.0" }, build: { mainProcess: "bun" } };\n'
);
const launcher = join(
  dirname(Bun.resolveSync("electrobun/package.json", import.meta.dir)),
  "bin/electrobun.cjs"
);
const child = Bun.spawn([process.execPath, launcher, "prepare", "--env=dev"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if ((await child.exited) !== 0) {
  throw new Error("Electrobun devkit preparation failed.");
}
await prepareSdkResolution(root);
// SDK 2.0.5's inferred default export exposes a private Session class during
// declaration emit (TS4094). Explicit typeof members preserve its original types.
const main = Bun.file(join(root, ".hutch/devkit/api/sdks/main/index.ts"));
const source = await main.text();
const match = source.match(/const Electrobun(?:: \{[^\n]+\})? = \{([\s\S]*?)\n\};/);
if (match?.[1]) {
  const names = match[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  await Bun.write(
    main,
    source.replace(
      /const Electrobun(?:: \{[^\n]+\})? = \{/,
      `const Electrobun: { ${names
        .map((name) => {
          const [key, value] = name.split(":").map((part) => part.trim());
          return `${key}: typeof ${value ?? key}`;
        })
        .join("; ")} } = {`
    )
  );
}

// Carrot worker types use self, which Bun does not declare on the main global.
const native = Bun.file(join(root, ".hutch/devkit/api/sdks/main/proc/native.ts"));
const nativeSource = await native.text();
if (!nativeSource.startsWith("declare const self: Worker;")) {
  await Bun.write(native, `declare const self: Worker;\n${nativeSource}`);
}
