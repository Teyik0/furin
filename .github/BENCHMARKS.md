# Performance checks

The PR CI runs deterministic bundle budgets on every push. The Vercel budget
report shows HEAD measurements even when the base branch has no Vercel adapter.
These are size budgets, not latency comparisons between frameworks.

## Live Furin / Next.js / TanStack Start comparison

Live runs deploy all three fixtures from the pinned
[benchmark repository](https://github.com/Teyik0/furin-vercel-benchmarks).
They are manual or weekly, not triggered automatically by untrusted pull requests.

1. Configure the repository Actions secret `VERCEL_TOKEN` with access to the
   benchmark projects. Set the `VERCEL_TEAM` repository variable if necessary.
   Never put the token in a committed file or a workflow input.
2. In **Actions → Vercel Framework Benchmark → Run workflow**, select the trusted
   PR's head branch and enter its number in `pull_request`. Only open PRs in this
   repository with a matching head commit are accepted.
3. Alternatively, for PR #129:

   ```sh
   gh workflow run vercel-benchmark.yaml \
     --ref feat/vercel-adapter \
     -f pull_request=129 \
     -f rounds=3 \
     -f warm_samples=5
   ```

The workflow must exist on the default branch before GitHub enables manual
dispatch. Its selected branch must contain the live comment job.

After a successful PR-associated run, a separate job automatically creates or
updates one **live benchmark comment**. It includes the full framework table:
backend latency, TTFB, total/navigation timings, medians, p95, cache status, sample
counts, deployment rounds, region, and measured Furin commit. The comment links to
the run and its raw JSON/Markdown artifact. It does not replace the budget comments.

If the PR changes or closes during the run, publication is skipped. Failed or
cancelled benchmarks do not publish a successful result; any previous comment
remains explicitly associated with its earlier commit and run. Scheduled runs and
manual runs without a PR number only produce a job summary and artifacts.

Live results are informational: network and platform variability make them
unsuitable as a deterministic merge gate. The benchmark's `/api/ping` is only a
bootstrap control; compare real SSR, loader, streaming, ISR and navigation scenarios.

All live workflow runs share one concurrency group because they deploy to the
same Vercel aliases. Do not run the benchmark locally while a CI live run is active.
Only the publication job has GitHub PR write permission; it checks out and executes
no application or benchmark code. Maintainers must still review the selected code
before dispatch: the deployment job executes it with access to the Vercel token.
