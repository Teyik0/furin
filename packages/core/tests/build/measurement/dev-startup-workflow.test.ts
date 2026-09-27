import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = Bun.YAML.parse(
  readFileSync(new URL("../../../../../.github/workflows/ci.yaml", import.meta.url), "utf8")
) as {
  jobs: {
    performance: {
      steps: Array<{ name: string; run?: string }>;
    };
  };
};

test("the performance budget job measures base and PR dev startup on the same runner", () => {
  const steps = workflow.jobs.performance.steps;
  const head = steps.find((step) => step.name === "Measure PR development startup")?.run;
  const base = steps.find((step) => step.name === "Measure baseline development startup")?.run;
  const enforce = steps.find((step) => step.name === "Enforce performance budgets")?.run;

  expect(head).toContain('measure-dev-startup.ts "$GITHUB_WORKSPACE"');
  expect(base).toContain('measure-dev-startup.ts "$RUNNER_TEMP/furin-base"');
  expect(enforce).toContain("compare-dev-startup.ts");
  expect(enforce).toContain('cat "$RUNNER_TEMP/furin-performance/startup-budgets.md"');
  expect(enforce).toContain('exit "$comparison_status"');
});
