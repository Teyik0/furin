# Performance checks

The PR CI runs deterministic bundle budgets on every push. The Vercel budget
report shows HEAD measurements even when the base branch has no Vercel adapter.
These are size budgets, not latency comparisons between frameworks.

## Live Furin / Next.js / TanStack Start comparison

Live runs deploy all three fixtures from the pinned
[benchmark repository](https://github.com/Teyik0/furin-vercel-benchmarks).
They run automatically when a same-repository PR targeting `main` is opened or
updated. Each run uses three deployment rounds and five warm samples.

Configure the repository Actions secret `VERCEL_TOKEN` with access to the
benchmark projects. Set the `VERCEL_TEAM` repository variable if necessary.
Never put the token in a committed file or workflow input.

After a successful run, a separate job automatically creates or updates one
**live benchmark comment**. It includes the full framework table:
backend latency, TTFB, total/navigation timings, medians, p95, cache status, sample
counts, deployment rounds, region, and measured Furin commit. The comment links to
the run and its raw JSON/Markdown artifact. It does not replace the budget comments.

If the PR changes or closes during the run, publication is skipped. Failed or
cancelled benchmarks do not publish a successful result; any previous comment
remains explicitly associated with its earlier commit and run.

Live results are informational: network and platform variability make them
unsuitable as a deterministic merge gate. The benchmark's `/api/ping` is only a
bootstrap control; compare real SSR, loader, streaming, ISR and navigation scenarios.

All live workflow runs share one concurrency group because they deploy to the
same Vercel aliases. Do not run the benchmark locally while a CI live run is active.
Only the publication job has GitHub PR write permission; it checks out and executes
no application or benchmark code.

Fork PRs are skipped because GitHub correctly withholds repository secrets from
them. Do not switch this workflow to `pull_request_target`: executing fork code with
the Vercel token would expose the credential. Same-repository PR authors are trusted
because the benchmark job executes their Furin source with access to that token.
