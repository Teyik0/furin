import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

interface ReportStep {
  id?: string;
  if?: string;
  name: string;
  with?: { script?: string };
}

const workflow = Bun.YAML.parse(
  readFileSync(
    new URL("../../../../../.github/workflows/performance-comment.yaml", import.meta.url),
    "utf8"
  )
) as { jobs: { comment: { steps: ReportStep[] } } };

test.each([
  { artifacts: [], available: false },
  { artifacts: [{ expired: false, name: "vercel-framework-benchmark" }], available: false },
  { artifacts: [{ expired: true, name: "furin-performance" }], available: false },
  { artifacts: [{ expired: false, name: "furin-performance" }], available: true },
])("only downloads and publishes an available report: %j", async ({ artifacts, available }) => {
  const steps = workflow.jobs.comment.steps;
  const discovery = steps.find((step) => step.name === "Find report");
  expect(discovery?.id).toBe("report");
  expect(discovery?.with?.script).toBeString();
  const outputs: Array<{ name: string; value: string }> = [];
  const requests: Array<{ owner: string; repo: string; run_id: number; per_page: number }> = [];
  await runInNewContext(`(async () => { ${discovery?.with?.script} })()`, {
    context: {
      payload: { workflow_run: { id: 123 } },
      repo: { owner: "Teyik0", repo: "furin" },
    },
    core: {
      info: () => undefined,
      setOutput: (name: string, value: string) => outputs.push({ name, value }),
    },
    github: {
      paginate: (_method: unknown, request: (typeof requests)[number]) => {
        requests.push(request);
        return artifacts;
      },
      rest: { actions: { listWorkflowRunArtifacts: () => undefined } },
    },
    process: { env: { REPORT_ARTIFACT: "furin-performance" } },
  });

  expect(requests).toEqual([{ owner: "Teyik0", repo: "furin", run_id: 123, per_page: 100 }]);
  expect(outputs).toEqual([{ name: "available", value: String(available) }]);
  for (const name of ["Download report", "Publish results"]) {
    expect(steps.find((step) => step.name === name)?.if).toBe(
      "steps.report.outputs.available == 'true'"
    );
  }
});
