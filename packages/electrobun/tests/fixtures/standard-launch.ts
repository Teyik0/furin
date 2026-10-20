import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopConfig } from "../../src/config";
import { installSdk } from "./sdk";

export async function standardLaunchFixture(options: {
  mode: "dev" | "build";
  dataDir?: DesktopConfig["dataDir"];
  channel?: string;
  failure?: string;
  startup?: string;
  handoff?: "reported" | "throw" | "cancelled";
  nativeLauncher?: boolean;
  applicationLease?: boolean;
  /** JavaScript expression returning the desktopApp listen option. */
  listen?: string;
}) {
  const directory = await mkdtemp(join(tmpdir(), "furin-standard-launch-"));
  const root = join(directory, "project");
  const buildHome = join(directory, "build-user");
  const launchHome = join(directory, "launch-user");
  const bundle = join(
    directory,
    "bundle",
    process.platform === "darwin" ? "Fixture.app/Contents" : "Fixture"
  );
  const application = join(bundle, "Resources/app");
  const cwd = join(bundle, process.platform === "darwin" ? "MacOS" : "bin");
  const script = "explicit native fixture";
  try {
    await Promise.all(
      [root, buildHome, launchHome, cwd, join(bundle, "Resources")].map((path) =>
        mkdir(path, { recursive: true })
      )
    );
    const entry = join(root, "server.ts");
    const source = `
      import {Elysia} from ${JSON.stringify(Bun.resolveSync("elysia", import.meta.dir))};
      import {desktopApp} from ${JSON.stringify(join(import.meta.dir, "../../src/server.ts"))};
      import {appendFileSync} from "node:fs";
      import {openNativeInstance} from ${JSON.stringify(join(import.meta.dir, "../../src/native-instance.ts"))};
      let desktop;
      let applicationLease;
      export default new Elysia().use(desktopApp({
        async onStartup({runtime}) {
          desktop=runtime.desktop;
          ${
            options.applicationLease
              ? `
          applicationLease=await openNativeInstance({
            dataDir:process.env.FURIN_APP_DATA_DIR+"/application-lease",
            identity:{identifier:"local.fixture.data",channel:"stable",version:"1.0.0",name:"Data"},
            schemes:[],extensions:[],onOpen(){},onActivate(){}
          });
          if(!applicationLease) throw new Error("Application data lease was not released");`
              : ""
          }
          appendFileSync(${JSON.stringify(join(root, "lifecycle"))},"start\\n");
          ${options.startup ?? ""}
        },
        async onReady({backend}) {
          await Bun.write(${JSON.stringify(join(root, "backend.json"))},JSON.stringify({
            ...backend,dataDir:process.env.FURIN_APP_DATA_DIR,cwd:process.cwd(),pid:process.pid
          }));
        },
        async onShutdown() {
          await applicationLease?.stop();
          appendFileSync(${JSON.stringify(join(root, "lifecycle"))},"stop\\n");
          ${options.failure ?? ""}
        },
        background:()=>true,
        ${options.listen ? `listen:${options.listen},` : ""}
        onOpen({event}) {
          appendFileSync(${JSON.stringify(join(root, "opens"))},JSON.stringify(event)+"\\n");
        }
      }))
      .get("/",()=>({dataDir:process.env.FURIN_APP_DATA_DIR,pid:process.pid}))
      .get("/update",()=>desktop.updates.install())
      .get("/quit",()=>desktop.quit())
      .get("/background",()=>desktop.window.background())
      .get("/open",()=>desktop.window.open());`;
    await writeFile(entry, source);
    await mkdir(join(root, ".furin/build/bun"), { recursive: true });
    await writeFile(join(root, ".furin/build/bun/app.js"), source);
    await writeFile(join(root, "native-test.js"), script);
    await writeFile(join(cwd, "native-test.js"), script);
    const config: DesktopConfig & { app: DesktopConfig["app"] & { version: string } } = {
      app: { name: "Fixture", identifier: "local.furin.launch", version: "1.0.0" },
      window: { width: 800, height: 600 },
      dataDir: options.dataDir,
      tray: {
        mac: { image: "icon.png" },
        win: { image: "icon.png" },
        linux: { image: "icon.png" },
      },
      sdk: { app: { urlSchemes: ["fixture"] } },
    };
    // Packaging executes under another user home; no launch directory is supplied.
    const builder = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
      import {prepareDesktop} from ${JSON.stringify(join(import.meta.dir, "../../src/prepare.ts"))};
      await prepareDesktop(${JSON.stringify(root)},${JSON.stringify(config)},${JSON.stringify({ mode: options.mode, root, serverEntry: entry })});
    `,
      ],
      {
        env: { ...process.env, HOME: buildHome, USERPROFILE: buildHome },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
        killSignal: "SIGKILL",
      }
    );
    const [status, error] = await Promise.all([
      builder.exited,
      new Response(builder.stderr).text(),
    ]);
    if (status !== 0) {
      throw new Error(error);
    }
    const generated = join(root, ".furin/electrobun");
    await installSdk(root, undefined, { metadataFromCwd: true, handoff: options.handoff });
    const built = await Bun.build({
      entrypoints: [join(generated, "main.ts")],
      target: "bun",
      outdir: join(application, "bun"),
      naming: "index.js",
    });
    if (!built.success) {
      throw new AggregateError(built.logs, "Fixture SDK build failed.");
    }
    if (options.mode === "build") {
      await cp(join(generated, "furin"), join(application, "furin"), { recursive: true });
    }
    await cp(join(generated, "host.json"), join(application, "bun/furin-host.json"));
    // Mirrors the SDK copy entries prepareDesktop declares for real packages.
    await cp(join(generated, "native-open.js"), join(application, "bun/native-open.js"));
    await cp(join(generated, "native-restart.js"), join(application, "bun/native-restart.js"));
    await writeFile(
      join(bundle, "Resources/version.json"),
      JSON.stringify({
        ...config.app,
        channel: options.channel ?? (options.mode === "dev" ? "dev" : "stable"),
      })
    );
    const runner = join(application, "bun/main.ts");
    await writeFile(
      runner,
      `process.on("message",signal=>{if(signal==="SIGINT"||signal==="SIGTERM")process.emit(signal);}); await import("./index.js");`
    );
    const launcher = join(cwd, process.platform === "win32" ? "launcher.exe" : "launcher");
    if (options.nativeLauncher) {
      const launcherSource = join(root, "launcher.ts");
      await writeFile(
        launcherSource,
        `
        import {appendFileSync} from "node:fs";
        const trace=${JSON.stringify(join(root, "launcher-events"))};
        appendFileSync(trace,JSON.stringify({type:"start",pid:process.pid})+"\\n");
        const child=Bun.spawn([${JSON.stringify(process.execPath)},${JSON.stringify(runner)}],{
          cwd:${JSON.stringify(cwd)},env:{...process.env,ELECTROBUN_LAUNCHER_PID:String(process.pid)},
          stdout:"inherit",stderr:"inherit",ipc:()=>{}
        });
        process.on("message",signal=>child.send(signal));
        const code=await child.exited;
        await Bun.sleep(200);
        appendFileSync(trace,JSON.stringify({type:"exit",pid:process.pid})+"\\n");
        process.exit(code);
      `
      );
      const compile = Bun.spawn(
        [process.execPath, "build", launcherSource, "--compile", "--outfile", launcher],
        { stdout: "pipe", stderr: "pipe" }
      );
      if ((await compile.exited) !== 0) {
        throw new Error(await new Response(compile.stderr).text());
      }
    }
    return {
      root,
      buildHome,
      launchHome,
      cwd,
      generated,
      script,
      launch(env?: NodeJS.ProcessEnv) {
        const child = Bun.spawn(options.nativeLauncher ? [launcher] : [process.execPath, runner], {
          cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          ipc: () => undefined,
          env: {
            ...process.env,
            HOME: launchHome,
            USERPROFILE: launchHome,
            // Linux handler registration writes the launching user's .desktop entry.
            XDG_DATA_HOME: join(launchHome, ".local/share"),
            APPDATA: join(launchHome, "AppData/Roaming"),
            FIXTURE_APP_DATA: join(launchHome, "sdk-data"),
            FURIN_DESKTOP_DEV: options.mode === "dev" ? join(generated, "dev.json") : "",
            FURIN_NATIVE_TEST_SCRIPT: "",
            ...env,
          },
        });
        const output = Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return {
          child,
          output,
          async stop(signal: "SIGINT" | "SIGTERM") {
            if (child.exitCode === null && child.signalCode === null) {
              child.send(signal);
            }
            const ended = await Promise.race([child.exited, Bun.sleep(6500).then(() => undefined)]);
            if (ended === undefined) {
              child.kill("SIGKILL");
              await child.exited;
              throw new Error("Fixture shutdown expired.");
            }
            return ended;
          },
        };
      },
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function waitForFixture<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean
): Promise<T> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: Poll observable fixture readiness.
    const value = await read();
    if (ready(value)) {
      return value;
    }
    await Bun.sleep(20);
  }
  throw new Error("Native fixture readiness expired.");
}
