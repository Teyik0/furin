import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

interface RscServerRuntimeResult {
  stderr: string;
  stdout: string;
}

async function runRscServerRuntimeScenario(mode: string): Promise<RscServerRuntimeResult> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=react-server",
      fileURLToPath(new URL("./rsc-server-runtime.scenario.tsx", import.meta.url)),
      mode,
    ],
    {
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr);
  }
  return { stderr, stdout };
}

test("renders a Server Component in the direct react-server graph", async () => {
  const result = await runRscServerRuntimeScenario("success");

  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ type: "success" });
});

test("preserves direct react-server render errors at the Flight boundary", async () => {
  const result = await runRscServerRuntimeScenario("render-error");

  expect(JSON.parse(result.stdout)).toEqual({
    causeIsOriginal: true,
    isFurinRscRenderError: true,
    message: `[furin/rsc] Server Component rendering failed inside renderServerComponent().

direct Flight render failed`,
    operation: "renderServerComponent",
    type: "error",
  });
});

test("rejects oversized Flight payloads in the direct react-server graph", async () => {
  const result = await runRscServerRuntimeScenario("oversized");

  expect(JSON.parse(result.stdout)).toEqual({
    message: "[furin/rsc] Flight payload exceeds the 4194304-byte safety limit.",
    type: "error",
  });
});
