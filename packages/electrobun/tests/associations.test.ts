import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssociations } from "../src/associations";

test("development cannot change default applications and invalid targets reject before OS calls", async () => {
  const associations = createAssociations({
    identity: { identifier: "local.furin.test", name: "Fixture", version: "1.0.0", channel: "dev" },
    dataDir: "/unused",
    helper: "/unused",
    openExternal: () => false,
  });
  await expect(associations.requestDefault({ scheme: "magnet" })).rejects.toThrow("development");
  await expect(associations.read({ extension: "../torrent" })).rejects.toThrow("Invalid");
});

test.skipIf(process.platform !== "darwin")(
  "macOS default queries use native APIs without changing defaults",
  async () => {
    const associations = createAssociations({
      identity: {
        identifier: "local.furin.test",
        name: "Fixture",
        version: "1.0.0",
        channel: "stable",
      },
      dataDir: "/unused",
      helper: "/unused",
      openExternal: () => false,
    });
    const result = await associations.read({ extension: "txt" });
    expect(result.status).toBe("confirmed");
    if (result.status === "confirmed") {
      expect(result.application === null || typeof result.application === "string").toBe(true);
    }
  }
);

test.skipIf(process.platform === "win32")(
  "Linux desktop entry retains registered schemes when adding a file association",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "furin-xdg-"));
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      const command = join(bin, "xdg-mime");
      // The native command boundary is a fixture; no user defaults are changed.
      await writeFile(
        command,
        `#!${process.execPath}
        if (Bun.argv[2] === "query") console.log("local.furin.xdg.furin-native.desktop");`
      );
      await chmod(command, 0o755);
      const helper = join(root, "helper.js");
      await writeFile(helper, "");
      const entry = join(root, "entry.ts");
      await writeFile(
        entry,
        `Object.defineProperty(process, "platform", {value:"linux"});
        const {createAssociations} = await import(${JSON.stringify(join(import.meta.dir, "../src/associations.ts"))});
        const associations = createAssociations({
          identity:{identifier:"local.furin.xdg",name:"Fixture",version:"1.0.0",channel:"stable"},
          helper:${JSON.stringify(helper)}, dataDir:${JSON.stringify(root)}, openExternal:()=>false,
        });
        await associations.registerProtocols(["fixture"]);
        await associations.requestDefault({extension:"torrent",mimeType:"application/x-bittorrent"});
        await associations.registerProtocols(["fixture"]);`
      );
      const child = Bun.spawn([process.execPath, entry], {
        env: { ...process.env, XDG_DATA_HOME: root, PATH: `${bin}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
        killSignal: "SIGKILL",
      });
      const [code, diagnostic] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(code, diagnostic).toBe(0);
      const desktop = await Bun.file(
        join(root, "applications/local.furin.xdg.furin-native.desktop")
      ).text();
      expect(desktop).toContain("x-scheme-handler/fixture");
      expect(desktop).toContain("application/x-bittorrent");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
