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
        await associations.registerHandlers({protocols:["fixture"],schemes:[],files:[]});
        await associations.requestDefault({extension:"torrent",mimeType:"application/x-bittorrent"});
        await associations.registerHandlers({protocols:["fixture"],schemes:[],files:[]});`
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

async function runAssociationFixture(platform: "linux" | "win32", script: string) {
  const root = await mkdtemp(join(tmpdir(), `furin-eligible-${platform}-`));
  const bin = join(root, "bin");
  await mkdir(bin);
  const calls = join(root, "calls.jsonl");
  // Native command boundaries are fixtures; no user registry or defaults change.
  for (const name of ["reg.exe", "xdg-mime", "update-desktop-database"]) {
    // biome-ignore lint/performance/noAwaitInLoops: Install each fixture command before running.
    await writeFile(
      join(bin, name),
      `#!${process.execPath}
      require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify([${JSON.stringify(name)}, ...Bun.argv.slice(2)]) + "\\n");`
    );
    await chmod(join(bin, name), 0o755);
  }
  const helper = join(root, "helper.js");
  await writeFile(helper, "");
  const entry = join(root, "entry.ts");
  await writeFile(
    entry,
    `Object.defineProperty(process, "platform", {value:${JSON.stringify(platform)}});
    const {createAssociations} = await import(${JSON.stringify(join(import.meta.dir, "../src/associations.ts"))});
    const associations = createAssociations({
      identity:{identifier:"local.furin.eligible",name:"Fixture",version:"1.0.0",channel:"stable"},
      helper:${JSON.stringify(helper)}, dataDir:${JSON.stringify(root)}, openExternal:()=>true,
    });
    ${script}`
  );
  const child = Bun.spawn([process.execPath, entry], {
    env: { ...process.env, XDG_DATA_HOME: root, PATH: `${bin}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  const [code, diagnostic] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  const recorded = (await Bun.file(calls).exists())
    ? (await Bun.file(calls).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
    : [];
  return { root, code, diagnostic, calls: recorded };
}

const ELIGIBILITY = `await associations.registerHandlers({
  protocols: [],
  schemes: ["magnet"],
  files: [{ name: "BitTorrent document", extensions: ["torrent"], mimeType: "application/x-bittorrent" }],
});`;

test.skipIf(process.platform === "win32")(
  "Windows lists the app for its file types and shared schemes without taking defaults",
  async () => {
    const result = await runAssociationFixture(
      "win32",
      ELIGIBILITY.replace("protocols: []", 'protocols: ["fixture"]')
    );
    try {
      expect(result.code, result.diagnostic).toBe(0);
      const added = result.calls
        .filter(([name, verb]) => name === "reg.exe" && verb === "add")
        .map((call) => call.slice(2, -1).join(" "));
      // The owned protocol becomes this app's handler.
      expect(added).toContainEqual(
        expect.stringContaining("HKCU\\Software\\Classes\\fixture\\shell\\open\\command /ve /d")
      );
      const progId = "HKCU\\Software\\Classes\\local.furin.eligible.torrent";
      expect(added).toContainEqual(
        expect.stringContaining(`${progId}\\shell\\open\\command /ve /d`)
      );
      expect(added).toContain(
        "HKCU\\Software\\Classes\\.torrent\\OpenWithProgids /v local.furin.eligible.torrent /d "
      );
      const capabilities = "HKCU\\Software\\local.furin.eligible\\Capabilities";
      expect(added).toContain(
        `${capabilities}\\FileAssociations /v .torrent /d local.furin.eligible.torrent`
      );
      expect(added).toContain(
        `${capabilities}\\URLAssociations /v magnet /d local.furin.eligible.url.magnet`
      );
      expect(added).toContain(
        "HKCU\\Software\\RegisteredApplications /v local.furin.eligible /d Software\\local.furin.eligible\\Capabilities"
      );
      // Eligibility only: the user's own choices are never written.
      expect(added.some((line) => line.includes("UserChoice"))).toBe(false);
      expect(added.some((line) => line.startsWith("HKCU\\Software\\Classes\\magnet"))).toBe(false);
    } finally {
      await rm(result.root, { recursive: true, force: true });
    }
  }
);

test.skipIf(process.platform === "win32")(
  "Linux lists the app for its file types and shared schemes without taking defaults",
  async () => {
    const result = await runAssociationFixture("linux", ELIGIBILITY);
    try {
      expect(result.code, result.diagnostic).toBe(0);
      const desktop = await Bun.file(
        join(result.root, "applications/local.furin.eligible.furin-native.desktop")
      ).text();
      expect(desktop).toContain("application/x-bittorrent;");
      expect(desktop).toContain("x-scheme-handler/magnet;");
      expect(result.calls.some(([name, verb]) => name === "xdg-mime" && verb === "default")).toBe(
        false
      );
    } finally {
      await rm(result.root, { recursive: true, force: true });
    }
  }
);
