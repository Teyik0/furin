import { expect, test } from "bun:test";

test("development loads render dependencies only for the requested page", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, `${import.meta.dir}/deferred-page.fixture.ts`],
    env: { ...process.env, NODE_ENV: "development" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ exitCode, output: exitCode === 0 ? "" : stdout + stderr }).toEqual({
    exitCode: 0,
    output: "",
  });
});
