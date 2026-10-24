import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSdk } from "./fixtures/sdk";

test("separately bundled app and native host share the canonical SDK window and controller", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-sdk-identity-"));
  const packageRoot = join(import.meta.dir, "..");
  try {
    const identity = { name: "Fixture", identifier: "local.furin.identity", version: "1.0.0" };
    await Bun.write(join(root, ".furin/electrobun/host.json"), JSON.stringify({ app: identity }));
    await installSdk(root);
    const appEntry = join(root, "application.ts");
    await Bun.write(
      appEntry,
      `
      import { Elysia } from ${JSON.stringify(Bun.resolveSync("elysia", import.meta.dir))};
      import { desktopApp, desktopContext } from ${JSON.stringify(join(packageRoot, "src/server.ts"))};
      const api = new Elysia().use(desktopContext).post('/minimize', ({desktop}) => {
        globalThis.routeDesktop = desktop;
        desktop.window.minimize();
        return {ok: true};
      });
      export default new Elysia().use(desktopApp({window:{title:'Bundled'}})).use(api);
    `
    );
    const appBuild = await Bun.build({
      entrypoints: [appEntry],
      target: "bun",
      outdir: root,
      naming: "app.js",
    });
    expect(appBuild.success).toBe(true);
    // Native code is bundled separately; the application artifact stays a dynamic runtime import.
    const nativeEntry = join(root, "native.ts");
    await Bun.write(
      nativeEntry,
      `
      import * as sdk from "electrobun/main";
      import { BrowserWindow as SubpathWindow } from "electrobun/main/browser-window";
      import { runStandardDesktopHost } from ${JSON.stringify(join(packageRoot, "src/standard-host.ts"))};
      import { getDesktopHost } from ${JSON.stringify(join(packageRoot, "src/host.ts"))};
      import { join } from 'node:path';
      Object.defineProperty(sdk.Utils,'quit',{value:()=>true});
      const artifact = join(import.meta.dir, 'app.js');
      let loaded;
      const desktop = await runStandardDesktopHost(sdk,{
        config:{app:${JSON.stringify(identity)}}, root:${JSON.stringify(root)}, dataDir:${JSON.stringify(join(root, "data"))}, mode:'build',
        load:async()=>{loaded=await import(artifact);return loaded;}
      });
      const response=await loaded.default.handle(new Request('http://in-process/minimize',{method:'POST'}));
      if(response.status!==200) throw new Error('Native API failed');
      if(globalThis.routeDesktop!==desktop || getDesktopHost()!==desktop) throw new Error('Controller duplicated across bundles');
      if(SubpathWindow!==sdk.BrowserWindow) throw new Error('SDK subpath constructor duplicated');
      if(!(desktop.window instanceof sdk.BrowserWindow)) throw new Error('SDK constructor duplicated');
      if(sdk.BrowserWindow.getById(desktop.window.id)!==desktop.window) throw new Error('SDK window map duplicated');
      if(!desktop.window.minimized) throw new Error('Route did not use original native method');
      await desktop.quit();
      console.log('canonical SDK identity verified');
    `
    );
    const nativeBuild = await Bun.build({
      entrypoints: [nativeEntry],
      target: "bun",
      outdir: root,
      naming: "host.js",
    });
    expect(nativeBuild.success).toBe(true);
    const child = Bun.spawn([process.execPath, join(root, "host.js")], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, output + error).toBe(0);
    expect(output).toContain("canonical SDK identity verified");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
