import type { LandingSlots } from "./landing-server";

const CALLOUTS = [
  {
    body: (
      <>
        A GET gets <code className="lp-code">{"sync: { id, scope }"}</code>. IDs and scopes are
        typed by your <code className="lp-code">SyncQueryMap</code>.
      </>
    ),
    title: "Name the read.",
  },
  {
    body: (
      <>
        Mutations return the reads they changed (<code className="lp-code">board</code>,{" "}
        <code className="lp-code">card</code>), atomic with{" "}
        <code className="lp-code">mutation(tx)</code>.
      </>
    ),
    title: "Invalidate by identity.",
  },
  {
    body: (
      <>
        <code className="lp-code">{"createClient<Api>"}</code>: Eden types, an{" "}
        <code className="lp-code">Idempotency-Key</code> on every write, safe retries.
      </>
    ),
    title: "One client.",
  },
  {
    body: (
      <>
        Loader props read from that GET follow it, with rollback on failure. No route target, no
        local state.
      </>
    ),
    title: "Optimistic on the GET.",
  },
] as const;

function CodePanel({ html, title }: { html: string; title: string }) {
  return (
    <div className="code-glass min-w-0 overflow-hidden rounded-2xl">
      <div className="flex items-center gap-2 border-white/[0.07] border-b px-4 py-2.5">
        <span className="size-2 rounded-full bg-white/15" />
        <span className="size-2 rounded-full bg-white/15" />
        <span className="size-2 rounded-full bg-white/15" />
        <span className="ml-2 font-mono text-[12px] text-zinc-400">{title}</span>
        <span className="ml-auto font-mono text-[11px] text-zinc-600">abridged</span>
      </div>
      {/* react-doctor-disable-next-line react/no-danger, react-doctor/dangerous-html-sink */}
      <div
        className="[&>pre]:overflow-x-auto [&>pre]:bg-transparent! [&>pre]:p-5 [&>pre]:font-mono [&>pre]:text-[12.5px] [&>pre]:leading-[1.7]"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted TanStack Highlight output of static snippets
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/** Sync DX: the real task-manager API (abridged) plus a two-tab demo of one optimistic move. */
export function SyncSection({
  clientHtml,
  serverHtml,
  Link,
  Reveal,
  SyncDemo,
}: Pick<LandingSlots, "Link" | "Reveal" | "SyncDemo"> & {
  clientHtml: string;
  serverHtml: string;
}) {
  return (
    <section className="lp-defer relative py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <Reveal className="mb-14 max-w-3xl">
          <p className="lp-eyebrow mb-5">04 — Sync</p>
          <h2 className="lp-h2 mb-6">
            Name the read.
            <br />
            <span className="lp-display__accent">Every tab follows.</span>
          </h2>
          <p className="max-w-xl text-muted-foreground leading-relaxed sm:text-lg">
            Give a GET an identity, say which identities a mutation changes, and describe the
            optimistic view. Furin does the plumbing: idempotent writes, invalidation and catch-up
            for every open tab.
          </p>
        </Reveal>

        <div className="grid gap-4 lg:grid-cols-2">
          <Reveal className="min-w-0">
            <CodePanel html={serverHtml} title="server · src/api/modules" />
          </Reveal>
          <Reveal className="min-w-0" delay={100}>
            <CodePanel html={clientHtml} title="client · src/lib" />
          </Reveal>
        </div>

        <ol className="mt-10 grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
          {CALLOUTS.map((callout, i) => (
            <li key={callout.title}>
              <Reveal className="sync-callout" delay={i * 80}>
                <span className="sync-callout__n">{i + 1}</span>
                <h3 className="font-medium text-[15px] text-foreground">{callout.title}</h3>
                <p className="mt-1.5 text-muted-foreground text-sm leading-relaxed">
                  {callout.body}
                </p>
              </Reveal>
            </li>
          ))}
        </ol>

        <Reveal className="mt-16">
          <SyncDemo />
        </Reveal>

        <p className="mt-10 text-center text-sm">
          <Link className="lp-link" to="/docs/sync">
            Read Sync &amp; Invalidations →
          </Link>
        </p>
      </div>
    </section>
  );
}
