import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDesktop } from "../src/prepare";

test("desktop build keeps the whole Furin artifact outside the SDK main bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-prepare-"));
  try {
    const artifact = join(root, ".furin/build/bun");
    await mkdir(join(artifact, "client/nested"), { recursive: true });
    await mkdir(join(artifact, "public"), { recursive: true });
    await writeFile(join(artifact, "app.js"), "export default {};");
    await writeFile(join(artifact, "client/nested/chunk.js"), "client");
    await writeFile(join(artifact, "public/logo.svg"), "public");
    const generated = await prepareDesktop(
      root,
      {
        app: { name: "Relay", identifier: "local.furin.relay", version: "1.2.3" },
        window: { width: 960, height: 720 },
      },
      { mode: "build", root, serverEntry: join(root, "src/server.ts") }
    );
    expect(await readFile(join(generated, "furin/client/nested/chunk.js"), "utf8")).toBe("client");
    expect(await readFile(join(generated, "furin/public/logo.svg"), "utf8")).toBe("public");
    const main = await readFile(join(generated, "main.ts"), "utf8");
    expect(main).toContain("pathToFileURL");
    expect(main).toContain("../furin/app.js");
    expect(main).toContain('renderer: "native"');
    expect(main).not.toContain("import app from");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
