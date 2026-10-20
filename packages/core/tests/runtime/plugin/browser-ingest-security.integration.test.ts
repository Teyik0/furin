import { expect, test } from "bun:test";
import { join } from "node:path";

// Runs in a subprocess with the real evlog: prototype pollution is process-wide
// and the shared test setup mocks evlog.
async function postIngest(bodies: string[]) {
  const source = `
import { Elysia } from "elysia";
import { furin } from "./src/furin.ts";

const events = [];
const app = new Elysia().use(
  await furin({
    clientLogging: true,
    logger: { drain: ({ event }) => { events.push(event); } },
    pagesDir: ${JSON.stringify(join(import.meta.dir, "../../fixtures/pages/default"))},
  })
);
const statuses = [];
for (const body of ${JSON.stringify(bodies)}) {
  const res = await app.handle(new Request("http://localhost/_furin/ingest", {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  }));
  statuses.push(res.status);
}
await Bun.sleep(50);
const ingest = events.filter((event) => event.path === "/_furin/ingest");
process.stdout.write("__RESULT__" + JSON.stringify({
  events: ingest,
  polluted: ({}).furinPolluted ?? null,
  statuses,
}));
`;
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", source],
    cwd: join(import.meta.dir, "../../.."),
    env: { ...process.env, NODE_ENV: "development" },
    stderr: "pipe",
    stdout: "pipe",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  const marker = stdout.lastIndexOf("__RESULT__");
  expect(marker, stdout).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(marker + "__RESULT__".length)) as {
    events: { browser?: { msg?: string }; status?: number }[];
    polluted: string | null;
    statuses: number[];
  };
}

test("nested __proto__ keys in browser events cannot pollute Object.prototype", async () => {
  const result = await postIngest([
    '[{"event":{"x":{"a":1}}},{"event":{"x":{"__proto__":{"furinPolluted":"yes"}}}}]',
  ]);

  expect(result.statuses).toEqual([204]);
  expect(result.polluted).toBeNull();
});

test("browser events cannot override server wide-event fields", async () => {
  const result = await postIngest([
    JSON.stringify([{ event: { msg: "from browser", path: "/spoofed", status: 500 } }]),
  ]);

  expect(result.statuses).toEqual([204]);
  expect(result.events).toHaveLength(1);
  expect(result.events[0]?.status).toBe(204);
  expect(result.events[0]?.browser?.msg).toBe("from browser");
});
