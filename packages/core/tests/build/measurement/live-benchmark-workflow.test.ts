import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

interface WorkflowStep {
  env?: {
    BENCHMARK_ROUNDS?: string;
    BENCHMARK_WARM_SAMPLES?: string;
    VERCEL_TOKEN?: string;
  };
  id?: string;
  if?: string;
  name: string;
  run?: string;
  with?: { ref?: string; script?: string };
}

const workflow = Bun.YAML.parse(
  readFileSync(new URL("../../../../../.github/workflows/vercel-benchmark.yaml", import.meta.url), "utf8")
) as {
  on: {
    pull_request?: unknown;
    schedule?: unknown;
    workflow_dispatch?: unknown;
  };
  jobs: {
    "live-vercel": {
      if?: string;
      outputs?: { supported?: string };
      permissions?: { "pull-requests"?: string };
      steps: WorkflowStep[];
    };
    comment?: { if?: string; steps: WorkflowStep[] };
  };
};
const ciWorkflow = Bun.YAML.parse(
  readFileSync(new URL("../../../../../.github/workflows/ci.yaml", import.meta.url), "utf8")
) as {
  jobs: {
    "vercel-benchmark": {
      steps: WorkflowStep[];
    };
  };
};
const sha = "a".repeat(40);
const table = `# Vercel framework benchmark

Rounds: 3; warm samples: 5; region: cdg1.

| Framework | Scenario | Median TTFB |
|---|---|---:|
| furin | dynamic | 50 ms |
| next | dynamic | 70 ms |
| tanstack | dynamic | 60 ms |
`;

function actionScript(job: "comment" | "live-vercel", name: string): string {
  const script = workflow.jobs[job]?.steps.find((step) => step.name === name)?.with?.script;
  expect(script).toBeString();
  return script as string;
}

interface Comment {
  body: string;
  id: number;
  user: { login: string };
}

async function publish(head: string, state: string, comments: Comment[]) {
  const created: { body: string; issue_number: number }[] = [];
  const updated: { body: string; comment_id: number }[] = [];
  await runInNewContext(`(async () => { ${actionScript("comment", "Publish live results")} })()`, {
    context: { repo: { owner: "Teyik0", repo: "furin" }, sha: "merge-commit" },
    core: { info: () => undefined },
    github: {
      paginate: () => comments,
      rest: {
        issues: {
          createComment: (comment: (typeof created)[number]) => created.push(comment),
          listComments: () => undefined,
          updateComment: (comment: (typeof updated)[number]) => updated.push(comment),
        },
        pulls: { get: () => ({ data: { state, head: { sha: head } } }) },
      },
    },
    process: {
      env: {
        MEASURED_SHA: sha,
        PR_NUMBER: "129",
        REPORT_PATH: "/report.md",
        RUN_URL: "https://github.com/Teyik0/furin/actions/runs/123",
      },
    },
    require: () => ({ readFileSync: () => table }),
  });
  return { created, updated };
}

async function validateCurrentPr(head: string, state: string) {
  const failures: string[] = [];
  const outputs: { name: string; value: string }[] = [];
  await runInNewContext(
    `(async () => { ${actionScript("live-vercel", "Validate current PR")} })()`,
    {
      context: { repo: { owner: "Teyik0", repo: "furin" } },
      core: {
        setFailed: (message: string) => failures.push(message),
        setOutput: (name: string, value: string) => outputs.push({ name, value }),
      },
      github: {
        rest: {
          pulls: { get: () => ({ data: { state, head: { sha: head } } }) },
        },
      },
      process: { env: { MEASURED_SHA: sha, PR_NUMBER: "129" } },
    }
  );
  return { failures, outputs };
}

test("publishes the live framework table with the measured commit and run link", async () => {
  const { created } = await publish(sha, "open", []);
  expect(created).toHaveLength(1);
  expect(created[0]?.issue_number).toBe(129);
  expect(created[0]?.body).toStartWith("<!-- furin-live-vercel-benchmark-report -->");
  expect(created[0]?.body).toContain(table.trim());
  expect(created[0]?.body).toContain(sha);
  expect(created[0]?.body).toContain("https://github.com/Teyik0/furin/actions/runs/123");
});

test("updates only its live bot comment without replacing budgets or human comments", async () => {
  const { created, updated } = await publish(sha, "open", [
    { body: "<!-- furin-performance-report -->", id: 1, user: { login: "github-actions[bot]" } },
    { body: "<!-- furin-live-vercel-benchmark-report -->", id: 2, user: { login: "github-actions[bot]" } },
    { body: "<!-- furin-live-vercel-benchmark-report -->", id: 3, user: { login: "human" } },
  ]);
  expect(created).toHaveLength(0);
  expect(updated).toHaveLength(1);
  expect(updated[0]?.comment_id).toBe(2);
  expect(updated[0]?.body).toContain(table.trim());
});

test.each([
  ["outdated", "open"],
  [sha, "closed"],
])("does not publish results for head %s and state %s", async (head, state) => {
  const { created, updated } = await publish(head, state, []);
  expect(created).toHaveLength(0);
  expect(updated).toHaveLength(0);
});

test.each([
  [sha, "open", true],
  ["outdated", "open", false],
  [sha, "closed", false],
])("validates current PR head %s and state %s before exposing secrets", async (head, state, current) => {
  const result = await validateCurrentPr(head, state);
  expect(result.failures.length === 0).toBe(current);
  expect(result.outputs).toContainEqual({ name: "current", value: String(current) });
});

test("runs automatically for same-repository PRs without scheduled or manual dispatch", () => {
  expect(workflow.on.pull_request).toBeDefined();
  expect(workflow.on.schedule).toBeUndefined();
  expect(workflow.on.workflow_dispatch).toBeUndefined();
  expect(workflow.jobs["live-vercel"].if).toContain(
    "github.event.pull_request.head.repo.full_name == github.repository"
  );
  expect(workflow.jobs.comment?.if).toContain(
    "github.event.pull_request.head.repo.full_name == github.repository"
  );
  expect(workflow.jobs.comment?.if).toContain(
    "needs.live-vercel.outputs.supported == 'true'"
  );
  expect(workflow.jobs["live-vercel"].outputs?.supported).toBe(
    "${{ steps.adapter-support.outputs.available }}"
  );
  expect(workflow.jobs["live-vercel"].permissions?.["pull-requests"]).toBe("read");
  expect(
    workflow.jobs["live-vercel"].steps.find((step) => step.name === "Check adapter support")?.id
  ).toBe("adapter-support");
  for (const name of ["Require Vercel credentials", "Run live benchmark"]) {
    expect(workflow.jobs["live-vercel"].steps.find((step) => step.name === name)?.if).toContain(
      "steps.pr-validation.outputs.current == 'true'"
    );
  }
  expect(
    workflow.jobs["live-vercel"].steps.find((step) => step.name === "Checkout Furin")?.with?.ref
  ).toBe("${{ github.event.pull_request.head.sha }}");
  expect(
    workflow.jobs["live-vercel"].steps.find((step) => step.name === "Run live benchmark")?.env
  ).toEqual({
    BENCHMARK_ROUNDS: "3",
    BENCHMARK_WARM_SAMPLES: "5",
    VERCEL_TOKEN: "${{ secrets.VERCEL_TOKEN }}",
  });
});

test.each([
  ["live", workflow.jobs["live-vercel"].steps],
  ["pull request", ciWorkflow.jobs["vercel-benchmark"].steps],
])("installs packed Furin with one Kiana dependency graph in the %s benchmark", (_name, steps) => {
  const packageStep = steps.find((step) => step.name === "Build and pack Furin HEAD")?.run;
  const installStep = steps.find((step) => step.name === "Install Furin benchmark package")?.run;

  expect(packageStep).toContain("bun pm pack");
  expect(packageStep).not.toContain("bun link");
  expect(installStep).toContain("bun add --cwd apps/furin --exact");
  expect(installStep).toContain('"$FURIN_HEAD_TARBALL"');
  expect(installStep).toContain("elysia@2.0.0-beta.16");
  expect(installStep).toContain("exact-mirror@1.2.6");
  expect(installStep).toContain("typebox@1.3.34");
});

test("compares Vercel bundles with the Elysia-major-aware budget", () => {
  const step = ciWorkflow.jobs["vercel-benchmark"].steps.find(
    (candidate) => candidate.name === "Enforce benchmark budgets"
  )?.run;

  expect(step).toContain("scripts/compare-vercel-framework-reports.ts");
  expect(step).toContain('"$RUNNER_TEMP/furin-benchmark-base/package.json"');
  expect(step).toContain('"$GITHUB_WORKSPACE/package.json"');
});

test.each([0, 1, 2])("prepares a publishable report only for one completed run (%i reports)", async (count) => {
  const directory = mkdtempSync(join(tmpdir(), "furin-live-report-"));
  try {
    mkdirSync(join(directory, "reports"));
    writeFileSync(join(directory, "reports/README.md"), "Benchmark report documentation");
    for (let index = 0; index < count; index++) {
      writeFileSync(join(directory, "reports", `${index}.md`), table);
    }
    const script = workflow.jobs["live-vercel"].steps.find((step) => step.name === "Prepare live report")?.run;
    expect(script).toBeString();
    const summary = join(directory, "step-summary.md");
    const child = Bun.spawn(["bash", "-e", "-o", "pipefail", "-c", script as string], {
      cwd: directory,
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary, MEASURED_SHA: sha },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect((await child.exited) === 0).toBe(count === 1);
    if (count === 1) {
      expect(readFileSync(join(directory, "reports/summary.md"), "utf8")).toBe(table);
      expect(readFileSync(summary, "utf8")).toContain(sha);
    } else {
      expect(await Bun.file(join(directory, "reports/summary.md")).exists()).toBe(false);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
