import { expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createTmpApp, writeAppFile } from "../../core/tests/support/app-fixtures";

test("one AOT production app serves SSR loaders and Eden mutations without internal network requests", async () => {
  const fixture = createTmpApp("cli-app");
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    writeAppFile(
      fixture.path,
      "package.json",
      JSON.stringify({ name: "fixture", version: "1.0.0", type: "module" })
    );
    writeAppFile(fixture.path, "furin.config.ts", 'export default {serverEntry:"src/server.ts"};');
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
      "src/server.ts",
      `
      import {Elysia,t} from "elysia";
      import {furin} from "@teyik0/furin";
      import {desktopApp} from "@teyik0/furin-electrobun/server";
      const values=["SSR internal"];
      const app=new Elysia().use(desktopApp({restrictWebToLoopback:true}))
        .get("/api/values",()=>values)
        .post("/api/values",{body:t.Object({value:t.String()})},({body})=>{values.push(body.value);return values;});
      app.use(await furin({pagesDir:import.meta.dir+"/pages"}));
      export default app;`
    );
    writeAppFile(
      fixture.path,
      "src/pages/index.tsx",
      `
      import {defineRoute} from "@teyik0/furin";
      import {createClient} from "@teyik0/furin/client";
      import {route as rootRoute} from "./root";
      export const route=defineRoute().config({layout:rootRoute,mode:"ssr"})
        .loader(async()=>{
          const {default:app}=await import("../server");
          const result=await createClient(app).api.values.get();
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
      const {default:app}=await import("./.furin/build/bun/app.js");
      const backend=await startDesktopBackend(()=>Promise.resolve({default:app}),${JSON.stringify(join(fixture.path, "data"))},"build");
      try {
        const client=treaty(app).api;
        const first=await client.values.get();
        if(first.status!==200) throw new Error("Bundled Eden read failed: "+first.status);
        const mutation=await client.values.post({value:"AOT mutation"});
        if(mutation.status!==200) throw new Error("Bundled Eden mutation failed: "+mutation.status);
        if((await fetch(backend.origin)).status!==403) throw new Error("HTTP guard bypassed");
        const html=await(await fetch(backend.origin,{headers:{cookie:backend.cookie,origin:backend.origin}})).text();
        if(!html.includes("SSR internal,AOT mutation")) throw new Error("SSR loader failed: "+html);
        console.log("one AOT root: Eden read/write and SSR passed");
      } finally {await backend.stop();}`
    );
    child = Bun.spawn([process.execPath, join(fixture.path, "run.ts")], {
      cwd: fixture.path,
      env: { ...process.env, NODE_ENV: "production" },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, error).toBe(0);
    expect(output).toContain("one AOT root: Eden read/write and SSR passed");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await child?.exited;
    fixture.cleanup();
  }
}, 30_000);
