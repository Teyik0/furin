import { Link } from "furinjs/link";
import { route } from "./root";

export default route.page({
  head: () => ({
    meta: [{ title: "Furin Read the Blog - React Meta-Framework" }],
    links: [{ rel: "canonical", href: "/" }],
  }),
  component: () => (
    <div>
      <section className="bg-linear-to-r from-indigo-600 to-purple-600 text-white">
        <div className="mx-auto max-w-7xl px-4 py-24 text-center sm:px-6 lg:px-8">
          <h1 className="mb-6 font-bold text-4xl sm:text-5xl">Build Modern Web Apps with Furin</h1>
          <p className="mx-auto mb-8 max-w-2xl text-indigo-100 text-xl">
            A React meta-framework powered by Elysia and Bun. File-based routing, SSR/SSG/ISR,
            nested layouts, and full TypeScript inference.
          </p>
          <div className="flex justify-center gap-4">
            <Link
              className="rounded-lg bg-white px-6 py-3 font-medium text-indigo-600 transition-colors hover:bg-gray-100"
              to="/blog"
            >
              Read the Blog
            </Link>
            <Link
              className="rounded-lg bg-indigo-500 px-6 py-3 font-medium text-white transition-colors hover:bg-indigo-400"
              to="/dashboard"
            >
              View Dashboard
            </Link>
          </div>
        </div>
      </section>

      <section className="bg-white py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 className="mb-12 text-center font-bold text-3xl">Features</h2>
          <div className="grid gap-8 md:grid-cols-3">
            <FeatureCard
              description="Automatic route generation from your file structure. Dynamic routes, nested layouts, and catch-all patterns."
              icon="file"
              title="File-Based Routing"
            />
            <FeatureCard
              description="SSR for dynamic content, SSG for static pages, ISR for the best of both worlds."
              icon="render"
              title="Multiple Rendering Modes"
            />
            <FeatureCard
              description="Complete TypeScript inference across the stack. No code generation required."
              icon="type"
              title="Full Type Safety"
            />
            <FeatureCard
              description="Compose your UI with powerful layout patterns. Data flows flat through the component tree."
              icon="layout"
              title="Nested Layouts"
            />
            <FeatureCard
              description="React Fast Refresh for instant feedback during development. Powered by Bun's speed."
              icon="hmr"
              title="Fast Refresh"
            />
            <FeatureCard
              description="Build your backend alongside your frontend with Elysia's powerful API capabilities."
              icon="api"
              title="API Routes"
            />
            <FeatureCard
              description='Compile to a standalone server binary with Bun. "server" keeps client assets separate; "embed" produces a single self-contained executable.'
              icon="compile"
              title="Bun Binary Compile"
            />
            <FeatureCard
              description="Pass Bun plugins (e.g. Tailwind, custom transforms) directly in furin.config.ts. They run before the internal client transform."
              icon="plugin"
              title="User Plugins"
            />
          </div>
        </div>
      </section>

      <section className="bg-gray-50 py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 className="mb-4 text-center font-bold text-3xl">This Demo App</h2>
          <p className="mx-auto mb-12 max-w-2xl text-center text-gray-600">
            Explore all Furin features through this complete blog + admin dashboard example.
          </p>
          <div className="grid gap-6 md:grid-cols-2">
            <DemoCard
              description="SSR list with pagination, ISR post pages with revalidation, nested layouts with sidebar"
              features={["SSR with query params", "ISR with revalidate", "Dynamic routes [slug]"]}
              href="/blog"
              title="Public Read the Blog"
            />
            <DemoCard
              description="Protected routes, nested layouts, CRUD operations with SQLite persistence"
              features={[
                "Auth-protected routes",
                "3-level nested layouts",
                "Create, Edit, Delete posts",
              ]}
              href="/dashboard"
              title="Admin Dashboard"
            />
          </div>
        </div>
      </section>

      <section className="bg-indigo-600 py-16 text-white">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="mb-4 font-bold text-2xl">Ready to Get Started?</h2>
          <p className="mb-8 text-indigo-100">
            Explore the blog or sign in to access the admin dashboard.
          </p>
          <a
            className="inline-block rounded-lg bg-white px-6 py-3 font-medium text-indigo-600 transition-colors hover:bg-gray-100"
            href="/login"
          >
            Sign In to Dashboard
          </a>
        </div>
      </section>
    </div>
  ),
});

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}) {
  const icons: Record<string, React.ReactNode> = {
    file: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <title>file</title>
        <path
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
      </svg>
    ),
    render: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <title>render</title>
        <path
          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
      </svg>
    ),
    type: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <title>type</title>
        <path
          d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
      </svg>
    ),
    layout: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <title>layout</title>
        <path
          d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
      </svg>
    ),
    hmr: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <title>hmr</title>
        <path
          d="M13 10V3L4 14h7v7l9-11h-7z"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
      </svg>
    ),
    api: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <title>api</title>
        <path
          d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
      </svg>
    ),
    compile: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <title>compile</title>
        <path
          d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
      </svg>
    ),
    plugin: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <title>plugin</title>
        <path
          d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
      </svg>
    ),
  };

  return (
    <div className="rounded-xl bg-gray-50 p-6">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600">
        {icons[icon]}
      </div>
      <h3 className="mb-2 font-semibold text-lg">{title}</h3>
      <p className="text-gray-600">{description}</p>
    </div>
  );
}

function DemoCard({
  title,
  description,
  href,
  features,
}: {
  title: string;
  description: string;
  href: string;
  features: string[];
}) {
  return (
    <a
      className="block rounded-xl border border-gray-200 bg-white p-6 transition-all hover:border-indigo-300 hover:shadow-lg"
      href={href}
    >
      <h3 className="mb-2 font-semibold text-lg">{title}</h3>
      <p className="mb-4 text-gray-600">{description}</p>
      <ul className="space-y-1">
        {features.map((feature) => (
          <li className="flex items-center text-gray-500 text-sm" key={feature}>
            <svg className="mr-2 h-4 w-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
              <title>{feature}</title>
              <path
                clipRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                fillRule="evenodd"
              />
            </svg>
            {feature}
          </li>
        ))}
      </ul>
    </a>
  );
}
