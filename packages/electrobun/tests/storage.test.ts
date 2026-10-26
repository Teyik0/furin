import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { defineDesktopConfig, validateDesktopConfig } from "../src/config";

test("runtime storage policy is declarative and absolute overrides remain valid", () => {
  const dataDir = { name: "Example", developmentName: "Example-dev", env: "EXAMPLE_DATA_DIR" };
  const config = defineDesktopConfig({
    app: { name: "Example", identifier: "app.example.desktop" },
    dataDir,
  });
  expect(JSON.parse(JSON.stringify(config)).dataDir).toEqual(dataDir);
  expect(defineDesktopConfig({ ...config, dataDir: tmpdir() }).dataDir).toBe(tmpdir());
  for (const invalid of [
    "relative/path",
    { name: "../release", developmentName: "dev" },
    { name: "Example", developmentName: "Example" },
    { name: "Example", developmentName: "dev", env: "INVALID=NAME" },
    { name: "Example" },
  ]) {
    expect(() => validateDesktopConfig({ ...config, dataDir: invalid })).toThrow("dataDir");
  }
});

test.each(["darwin", "linux", "win32"] as const)(
  "runtime storage resolves %s home, channel and environment at launch",
  async (platform) => {
    const directory = await mkdtemp(join(tmpdir(), "furin-storage-"));
    try {
      // An emulated POSIX home must remain absolute when this test runs on Windows.
      const home =
        process.platform === "win32" && platform !== "win32"
          ? `/furin-storage-${crypto.randomUUID()}`
          : directory;
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `Object.defineProperty(process, "platform", {value:${JSON.stringify(platform)}});
          const {resolveDesktopDataDir} = await import(${JSON.stringify(join(import.meta.dir, "../src/host.ts"))});
          const policy = {name:"Example",developmentName:"Example-dev",env:"EXAMPLE_DATA_DIR"};
          const context = {channel:"stable",root:${JSON.stringify(directory)},mode:"build"};
          const release = await resolveDesktopDataDir(policy, context);
          const development = await resolveDesktopDataDir(policy, {...context,channel:"dev"});
          if(process.platform==="win32") {
            process.env.APPDATA = "C:\\\\Users\\\\launch\\\\CustomRoaming";
            const roaming = await resolveDesktopDataDir(policy, context);
            if(roaming!=="C:\\\\Users\\\\launch\\\\CustomRoaming\\\\Example") throw new Error("APPDATA ignored");
            delete process.env.APPDATA;
          }
          process.env.EXAMPLE_DATA_DIR = release;
          let isolated = false;
          try { await resolveDesktopDataDir(policy, {...context,channel:"dev"}); }
          catch { isolated = true; }
          console.log(JSON.stringify({release,development,isolated}));`,
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            APPDATA: undefined,
            EXAMPLE_DATA_DIR: undefined,
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
          killSignal: "SIGKILL",
        }
      );
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, error).toBe(0);
      const paths = JSON.parse(output) as {
        release: string;
        development: string;
        isolated: boolean;
      };
      expect(paths.isolated).toBe(true);
      const prefix = {
        darwin: posix.join(home, "Library/Application Support"),
        linux: posix.join(home, ".local/share"),
        win32: win32.resolve(home, "AppData/Roaming"),
      }[platform];
      const separator = platform === "win32" ? "\\" : "/";
      expect(paths.release).toBe(`${prefix}${separator}Example`);
      expect(paths.development).toBe(`${prefix}${separator}Example-dev`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test("runtime overrides honor source root and reject release aliases without altering data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "furin-storage-alias-"));
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
      import {mkdir,symlink,readFile,writeFile,realpath} from "node:fs/promises";
      import {join} from "node:path";
      import {resolveDesktopDataDir} from ${JSON.stringify(join(import.meta.dir, "../src/host.ts"))};
      const root=${JSON.stringify(directory)};
      const policy={name:"Example",developmentName:"Example-dev",env:"EXAMPLE_DATA_DIR"};
      const context={root,mode:"dev",channel:"dev"};
      process.env.EXAMPLE_DATA_DIR="relative/state";
      const relative=await resolveDesktopDataDir(policy,context);
      if(relative!==join(await realpath(root),"relative/state")) throw new Error("Wrong source root");
      const supervised=await resolveDesktopDataDir(policy,{...context,env:{
        APPDATA:process.env.APPDATA,EXAMPLE_DATA_DIR:"supervisor/state"
      }});
      if(supervised!==join(await realpath(root),"supervisor/state")) throw new Error("Supervisor environment ignored");
      delete process.env.EXAMPLE_DATA_DIR;
      const release=await resolveDesktopDataDir(policy,{...context,channel:"stable"});
      await mkdir(release,{recursive:true});
      await writeFile(join(release,"existing-data"),"preserved");
      const alias=join(root,"release-alias");
      await symlink(release,alias,process.platform==="win32"?"junction":"dir");
      process.env.EXAMPLE_DATA_DIR=join(alias,"new-child");
      let rejected=false;
      try {await resolveDesktopDataDir(policy,context);} catch(error){rejected=error.message.includes("reserved for release");}
      if(!rejected) throw new Error("Release alias allowed");
      if(await Bun.file(join(release,"new-child")).exists()) throw new Error("Resolver created release data");
      if(await readFile(join(release,"existing-data"),"utf8")!=="preserved") throw new Error("Data changed");
    `,
      ],
      {
        env: {
          ...process.env,
          HOME: directory,
          USERPROFILE: directory,
          APPDATA: join(directory, "roaming"),
          EXAMPLE_DATA_DIR: undefined,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
        killSignal: "SIGKILL",
      }
    );
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, error).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
