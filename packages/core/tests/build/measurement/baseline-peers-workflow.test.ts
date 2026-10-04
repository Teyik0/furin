import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Peer = "elysia" | "evlog" | "exact-mirror" | "typebox";

const workflow = Bun.YAML.parse(
  readFileSync(new URL("../../../../../.github/workflows/ci.yaml", import.meta.url), "utf8")
) as { jobs: { "vercel-benchmark": { steps: { name: string; run?: string }[] } } };
const step = workflow.jobs["vercel-benchmark"].steps.find(
  (entry) => entry.name === "Build baseline benchmark"
)?.run;
const script = (() => {
  const value = step?.match(/bun -e '(\s+const baseline =[\s\S]*?)\n'/)?.[1];
  if (!value) {
    throw new Error("Missing baseline peer alignment script");
  }
  return value;
})();

function align(catalog: Partial<{ [K in Peer]: string }>, packages: { [name: string]: [string] }) {
  const root = mkdtempSync(join(tmpdir(), "furin-baseline-peers-"));
  try {
    const baseline = join(root, "furin-benchmark-base");
    mkdirSync(baseline);
    writeFileSync(join(baseline, "package.json"), JSON.stringify({ catalog }));
    writeFileSync(
      join(baseline, "bun.lock"),
      `{"lockfileVersion": 2, "packages": ${JSON.stringify(packages)},}`
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { elysia: "original", evlog: "original", unrelated: "keep" } })
    );
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: root,
      env: { RUNNER_TEMP: root },
    });
    return {
      status: result.exitCode,
      error: result.stderr.toString(),
      dependencies: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies as {
        elysia: string;
        evlog: string;
        unrelated: string;
        "exact-mirror"?: string;
        typebox?: string;
      },
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("baseline peers use resolved lock versions rather than drifting catalog ranges", () => {
  const result = align(
    { elysia: "2.0.0-beta.21", evlog: "^2.29.0", "exact-mirror": "^1.2.6", typebox: "^1.3.34" },
    {
      elysia: ["elysia@2.0.0-beta.21"],
      evlog: ["evlog@2.29.0"],
      "exact-mirror": ["exact-mirror@1.2.6"],
      typebox: ["typebox@1.3.34"],
    }
  );
  expect(result.status).toBe(0);
  expect(result.dependencies).toEqual({
    elysia: "2.0.0-beta.21",
    evlog: "2.29.0",
    "exact-mirror": "1.2.6",
    typebox: "1.3.34",
    unrelated: "keep",
  });
});

test("legacy baseline peers leave absent catalog peers and unrelated dependencies intact", () => {
  const result = align(
    { elysia: "^1.4.0" },
    { elysia: ["elysia@1.4.28"], evlog: ["evlog@2.29.0"] }
  );
  expect(result.status).toBe(0);
  expect(result.dependencies).toEqual({
    elysia: "1.4.28",
    evlog: "original",
    unrelated: "keep",
  });
});

test.each([undefined, "typebox@1.3.34", "evlog@"])(
  "declared baseline peer fails clearly when its lock resolution is %s",
  (resolved) => {
    const result = align({ evlog: "^2.29.0" }, resolved ? { evlog: [resolved] } : {});
    expect(result.status).not.toBe(0);
    expect(result.error).toContain("Cannot resolve baseline peer evlog from baseline bun.lock");
    expect(result.dependencies.evlog).toBe("original");
  }
);
