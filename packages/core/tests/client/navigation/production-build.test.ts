import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const PROVIDER = fileURLToPath(new URL("../../../src/client/router/provider.tsx", import.meta.url));

async function bundle(nodeEnv: string): Promise<string> {
  const result = await Bun.build({
    define: { "process.env.NODE_ENV": JSON.stringify(nodeEnv) },
    entrypoints: [PROVIDER],
    minify: true,
    packages: "external",
    target: "browser",
  });
  const [output] = result.outputs;
  if (!output) {
    throw new Error("provider bundle produced no output");
  }
  return await output.text();
}

test("production router bundles contain no HMR-only code", async () => {
  const [development, production] = await Promise.all([
    bundle("development"),
    bundle("production"),
  ]);
  for (const marker of ["furin.router.hmr-refreshes.v1", "x-furin-hmr-refresh"]) {
    expect(development).toContain(marker);
    expect(production).not.toContain(marker);
  }
});
