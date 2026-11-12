import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each([
  ["plain", "src/server.ts", true, false],
  ["hot", "other.ts", true, false],
  ["hot", "src/server.ts", false, false],
  ["hot", "src/server.ts", true, true],
] as const)(
  "desktop preload stays inert for %s / %s / desktop=%s / managed=%s",
  async (mode, entry, configured, managed) => {
    const root = await mkdtemp(join(tmpdir(), "furin-preload-inert-"));
    try {
      await mkdir(join(root, "src"));
      await mkdir(join(root, "node_modules/@teyik0"), { recursive: true });
      await symlink(
        join(import.meta.dir, ".."),
        join(root, "node_modules/@teyik0/furin-electrobun"),
        "dir"
      );
      await writeFile(
        join(root, "bunfig.toml"),
        'preload = ["@teyik0/furin-electrobun/preload"]\n'
      );
      await writeFile(
        join(root, "furin.config.ts"),
        configured ? "export default {desktop:{}};" : "export default {};"
      );
      const source = `await Bun.write(${JSON.stringify(join(root, "ran"))}, "ran"); process.exit(0);`;
      await writeFile(join(root, "src/server.ts"), source);
      await writeFile(join(root, "other.ts"), source);
      const child = Bun.spawn([process.execPath, ...(mode === "hot" ? ["--hot"] : []), entry], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
        killSignal: "SIGKILL",
        env: { ...process.env, ...(managed ? { FURIN_DESKTOP_DEV: "managed" } : {}) },
      });
      const [code, diagnostic] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(code, diagnostic).toBe(0);
      expect(await Bun.file(join(root, "ran")).text()).toBe("ran");
      expect(await Bun.file(join(root, ".furin")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
