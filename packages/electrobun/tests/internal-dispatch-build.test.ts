import { expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createTmpApp, writeAppFile } from "./support/core";

test.each(["default", "listen"] as const)(
  "one AOT production app with a %s entry serves SSR and Eden mutations",
  async (entry) => {
    const fixture = createTmpApp("cli-app");
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    try {
      const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const { port } = probe;
      await probe.stop(true);
      writeAppFile(
        fixture.path,
        "package.json",
        JSON.stringify({ name: "fixture", version: "1.0.0", type: "module" })
      );
      writeAppFile(
        fixture.path,
        "furin.config.ts",
        'export default {serverEntry:"src/server.ts"};'
      );
      // Source imports use public package entrypoints; bundling preserves one root.
      const coreRoot = join(import.meta.dir, "../../core");
      const sdkRoot = join(import.meta.dir, "..");
      for (const [name, path] of [
        ["@teyik0/furin", coreRoot],
        ["@teyik0/furin-electrobun", sdkRoot],
        ["elysia", dirname(dirname(Bun.resolveSync("elysia", import.meta.dir)))],
        ["@elysia/eden", dirname(dirname(Bun.resolveSync("@elysia/eden", import.meta.dir)))],
      ] as const) {
        const link = join(fixture.path, "node_modules", name);
        // biome-ignore lint/performance/noAwaitInLoops: Create fixture package links in order.
        await mkdir(dirname(link), { recursive: true });
        await symlink(path, link, "dir");
      }
      writeAppFile(
        fixture.path,
        "src/api.ts",
        `
      import {Elysia,t} from "elysia";
      import {appendFileSync} from "node:fs";
      import {furin} from "@teyik0/furin";
      import {furinSync,PollingSyncNotifier} from "@teyik0/furin/sync";
      import {migrateSqliteSync,sqliteSyncAdapter} from "@teyik0/furin/sync/sqlite";
      import {Database} from "bun:sqlite";
      import {desktopApp} from "@teyik0/furin-electrobun/server";
      const values=["SSR internal"];
      const observed=[];
      const database=new Database("sync.sqlite");
      migrateSqliteSync(database);
      const adapter=sqliteSyncAdapter({database,namespace:"desktop-aot"});
      const sync={adapter,notifier:new PollingSyncNotifier(adapter,1000),principal:()=>"test"};
      const apiPlugin=new Elysia()
        .use(furinSync(sync))
        .wrap((next)=>(request,...rest)=>{
          observed.push("wrapper");
          if(new URL(request.url).pathname==="/wrapper-shortcut") return new Response("shortcut");
          return next(request,...rest);
        })
        .get("/api/values",()=>{observed.push("read");return values;})
        .post("/api/values",{body:t.Object({value:t.String()})},({body})=>{observed.push("write");values.push(body.value);return values;});
      let starts=0;
      let stops=0;
      let timer;
      export const app=new Elysia().use(apiPlugin).use(desktopApp({restrictWebToLoopback:true})).onStart(() => {
          starts++;
          timer=setInterval(()=>{},1000);
          appendFileSync(process.env.FIXTURE_LIFECYCLE,"start\\n");
        }).onStart(() => {if(process.env.FIXTURE_FAIL_READY) throw new Error("fixture ready failed");}).onStop(() => {
          stops++;
          clearInterval(timer);
          database.close();
          appendFileSync(process.env.FIXTURE_LIFECYCLE,"stop\\n");
        })
        .get("/lifecycle",()=>({starts,stops}));
      app.use(await furin({pagesDir:import.meta.dir+"/pages",sync}));
      Object.assign(app,{getObserved:()=>observed});
      `
      );
      writeAppFile(
        fixture.path,
        "src/server.ts",
        `import {app} from "./api";
      ${entry === "default" ? "export default app;" : `app.listen({hostname:"127.0.0.1",port:${port}},()=>{throw new Error("Source listener must not run");});`} `
      );
      writeAppFile(
        fixture.path,
        "src/pages/index.tsx",
        `
      import {defineRoute} from "@teyik0/furin";
      import {treaty} from "@elysia/eden";
      import {furinSync} from "@teyik0/furin/client";
      export const route=defineRoute("/").config({mode:"ssr"})
        .loader(async()=>{
          const {app}=await import("../api");
          const result=await treaty(app).use(furinSync).api.values.get();
          if(result.error) throw new Error("Internal loader API rejected: "+result.status);
          return {values:result.data};
        }).page(({values})=><main>{values.join(",")}</main>);`
      );
      const compiler = Bun.spawn(
        [
          process.execPath,
          join(coreRoot, "src/cli/index.ts"),
          "build",
          "--target",
          "bun",
          "--output",
          "app",
        ],
        {
          cwd: fixture.path,
          stdout: "pipe",
          stderr: "pipe",
          timeout: 20_000,
          killSignal: "SIGKILL",
        }
      );
      const [built, buildError] = await Promise.all([
        compiler.exited,
        new Response(compiler.stderr).text(),
      ]);
      expect(built, buildError).toBe(0);
      writeAppFile(
        fixture.path,
        "run.ts",
        `
      import {startDesktopBackend} from ${JSON.stringify(join(import.meta.dir, "../src/host.ts"))};
      import {treaty} from "@elysia/eden";
      async function run(){
      let app;
      const load=async()=>{
        const module=await import("./.furin/build/bun/app.js");
        app=module.default;
        if(app.server) throw new Error("Artifact import opened a listener");
        if(await Bun.file(process.env.FIXTURE_LIFECYCLE).exists()) throw new Error("Import ran lifecycle hooks");
        return module;
      };
      const module=process.env.FIXTURE_LOAD_IN_HOST ? undefined : await load();
      const loadArtifact=()=>module ? Promise.resolve(module) : load();
      if(process.env.FIXTURE_FAIL_READY){
        try {
          await startDesktopBackend(loadArtifact,${JSON.stringify(join(fixture.path, "data"))},"build");
          throw new Error("Expected readiness failure");
        } catch(error){if(error.message!=="fixture ready failed") throw error; process.exitCode=0;}
        if(await Bun.file(process.env.FIXTURE_LIFECYCLE).text()!=="start\\nstop\\n") throw new Error("Failure did not clean resources once");
        console.log("failed startup cleaned resources");
        return;
      }
      const backend=await startDesktopBackend(loadArtifact,${JSON.stringify(join(fixture.path, "data"))},"build");
      try {
        ${entry === "listen" ? `if(backend.origin!=="http://127.0.0.1:${port}") throw new Error("Source listen port was lost: "+backend.origin);` : ""}
        if((await(await app.handle("/lifecycle")).json()).starts!==1) throw new Error("Startup must run once");
        const client=treaty(app).api;
        const first=await client.values.get();
        if(first.status!==200) throw new Error("Bundled Eden read failed: "+first.status);
        const mutation=await client.values.post({value:"AOT mutation"});
        if(mutation.status!==200) throw new Error("Bundled Eden mutation failed: "+JSON.stringify(mutation.error));
        const before=app.getObserved().length;
        for(const path of ["/","/wrapper-shortcut","/api/values"]){
          if((await fetch(backend.origin+path)).status!==403) throw new Error("HTTP guard bypassed: "+path);
        }
        if(app.getObserved().length!==before) throw new Error("Rejected HTTP reached application wrappers or routes");
        const html=await(await fetch(backend.origin,{headers:{cookie:backend.cookie,origin:backend.origin}})).text();
        if(!html.includes("SSR internal,AOT mutation")) throw new Error("SSR loader failed: "+html);
        console.log("one AOT root: Eden read/write and SSR passed");
      } finally {await backend.stop();await backend.stop();}
      if(await Bun.file(process.env.FIXTURE_LIFECYCLE).text()!=="start\\nstop\\n") throw new Error("Shutdown must clean resources once");
      try {await fetch(backend.origin);throw new Error("Listener survived shutdown");}
      catch(error){if(error.message==="Listener survived shutdown") throw error;}
      }
      await run();`
      );
      for (const mode of ["preloaded", "hosted", "failed"] as const) {
        const failure = mode === "failed";
        const lifecycle = join(fixture.path, `${mode}-lifecycle`);
        child = Bun.spawn([process.execPath, join(fixture.path, "run.ts")], {
          cwd: fixture.path,
          env: {
            ...process.env,
            NODE_ENV: "production",
            FIXTURE_LIFECYCLE: lifecycle,
            FIXTURE_FAIL_READY: failure ? "1" : "",
            FIXTURE_LOAD_IN_HOST: mode === "preloaded" ? "" : "1",
          },
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          timeout: 15_000,
          killSignal: "SIGKILL",
        });
        // biome-ignore lint/performance/noAwaitInLoops: Each fresh process exercises one artifact lifecycle.
        const [code, output, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code, error).toBe(0);
        expect(output).toContain(
          failure
            ? "failed startup cleaned resources"
            : "one AOT root: Eden read/write and SSR passed"
        );
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await child?.exited;
      fixture.cleanup();
    }
  },
  30_000
);
