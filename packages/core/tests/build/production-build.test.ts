import { expect, test } from "bun:test";
test("concurrent first builds keep their production context", async () => {
  const moduleUrl = new URL("../../src/shared/production-build.ts", import.meta.url).href;
  const script = `
    const { isProductionBuild, withProductionBuild } = await import(${JSON.stringify(moduleUrl)});
    let started = 0;
    let release;
    const bothStarted = new Promise((resolve) => { release = resolve; });
    const observed = await Promise.all([0, 1].map(() => withProductionBuild(async () => {
      if (++started === 2) release();
      await bothStarted;
      return isProductionBuild();
    })));
    if (observed.some((value) => !value)) throw new Error("concurrent build lost production context");
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, NODE_ENV: "test" },
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("production detection works without a process global", async () => {
  const moduleUrl = new URL("../../src/rsc/render-error.ts", import.meta.url).href;
  const script = `
    const { FurinRscRenderError } = await import(${JSON.stringify(moduleUrl)});
    const originalProcess = globalThis.process;
    Reflect.set(globalThis, "process", undefined);
    try {
      const error = new FurinRscRenderError({ cause: new Error("cause"), component: undefined, hook: undefined, operation: "renderServerComponent" });
      if (!error.message.includes("cause")) throw new Error("missing error message");
    } finally {
      Reflect.set(globalThis, "process", originalProcess);
    }
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});
