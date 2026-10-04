import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test.each(["development", "production"])(
  "%s composite content resolves interactive slots inside Suspense",
  async (mode) => {
    const child = Bun.spawn(
      [process.execPath, fileURLToPath(new URL("./rsc-suspense.scenario.tsx", import.meta.url))],
      {
        env: { ...process.env, FURIN_RSC_CODEC_PATH: "", NODE_ENV: mode },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const [exitCode, html, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(html).toContain('<button type="button">Loaded section</button>');
    expect(html).not.toContain("<furin-rsc-slot");
  }
);
