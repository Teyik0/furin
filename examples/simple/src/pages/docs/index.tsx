import { Link, type RouteManifest } from "@teyik0/furin/link";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "Documentation — Furin" }],
  }),
  component: () => (
    <div className="prose prose-slate dark:prose-invert max-w-none">
      <h1 className="mb-2 font-bold text-4xl text-foreground">Documentation</h1>
      <p className="mb-10 text-lg text-muted-foreground">
        Everything you need to build fast, type-safe web apps with Furin.
      </p>

      <div className="not-prose grid gap-4 sm:grid-cols-2">
        {[
          {
            title: "Getting Started",
            desc: "Install Furin and create your first app in minutes.",
            href: "/docs/getting-started",
            badge: "Start here",
          },
          {
            title: "File-Based Routing",
            desc: "Automatic routes from your file structure.",
            href: "/docs/routing",
            badge: null,
          },
          {
            title: "Data Loading",
            desc: "SSR, SSG, and ISR with type-safe loaders.",
            href: "/docs/data-loading",
            badge: null,
          },
          {
            title: "Deployment",
            desc: "Build and deploy to Bun, Vercel, or Cloudflare.",
            href: "/docs/deployment",
            badge: null,
          },
        ].map((card) => (
          <Link
            className="group rounded-xl border border-border bg-card p-6 transition-all hover:border-foreground/20 hover:shadow-sm"
            key={card.href}
            to={card.href as keyof RouteManifest}
          >
            <div className="mb-2 flex items-center gap-2">
              <h3 className="font-semibold text-foreground">{card.title}</h3>
              {card.badge && (
                <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-blue-600 text-xs dark:text-blue-400">
                  {card.badge}
                </span>
              )}
            </div>
            <p className="text-muted-foreground text-sm">{card.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  ),
});
