// biome-ignore-all lint/performance/noAwaitInLoops: readiness probes must retry sequentially

import { resolve } from "node:path";

const [, , binaryPath] = Bun.argv;
if (binaryPath === undefined) {
  console.error("Usage: bun scripts/probe-server-startup.ts <server-binary>");
  process.exit(1);
}

const port = 32_109;
const server = Bun.spawn({
  cmd: [resolve(binaryPath)],
  env: { ...process.env, PORT: String(port) },
  stderr: "pipe",
  stdout: "pipe",
});
const startedAt = Bun.nanoseconds();

try {
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/definitely-missing`);
      ready = true;
      break;
    } catch {
      await Bun.sleep(10);
    }
  }
  if (!ready) {
    const stderr = await new Response(server.stderr).text();
    throw new Error(`Server did not become ready.\n${stderr}`);
  }
  console.log(`${((Bun.nanoseconds() - startedAt) / 1_000_000).toFixed(2)} ms`);
} finally {
  server.kill();
  await server.exited;
}
