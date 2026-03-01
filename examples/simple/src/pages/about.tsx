import { Link } from "@teyik0/elysion/link";
import { route } from "./root";

export default route.page({
  head: () => ({
    meta: [{ title: "About - Elysion Blog" }],
  }),
  component: () => (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
      <h1 className="mb-8 font-bold text-4xl">About Elysion</h1>

      <div className="prose prose-lg max-w-none">
        <p className="mb-8 text-gray-600 text-xl">
          Elysion is a modern React meta-framework that combines the speed of Bun with the
          flexibility of Elysia to create blazing fast web applications.
        </p>

        <h2 className="mt-8 mb-4 font-bold text-2xl">Why Elysion?</h2>
        <p className="mb-4 text-gray-600">
          Traditional React frameworks often force you to choose between performance and developer
          experience. Elysion eliminates that compromise by leveraging Bun's native speed and
          Elysia's elegant API design.
        </p>

        <h2 className="mt-8 mb-4 font-bold text-2xl">Key Concepts</h2>

        <div className="mb-6 rounded-lg bg-gray-50 p-6">
          <h3 className="mb-2 font-semibold text-lg">Rendering Modes</h3>
          <ul className="space-y-2 text-gray-600">
            <li>
              <strong>SSG (Static Site Generation):</strong> Pre-render pages at build time. Perfect
              for blogs, docs, marketing pages.
            </li>
            <li>
              <strong>SSR (Server-Side Rendering):</strong> Render on each request. Ideal for
              personalized content.
            </li>
            <li>
              <strong>ISR (Incremental Static Regeneration):</strong> Static pages with periodic
              updates. Best of both worlds.
            </li>
          </ul>
        </div>

        <div className="mb-6 rounded-lg bg-gray-50 p-6">
          <h3 className="mb-2 font-semibold text-lg">Nested Layouts</h3>
          <p className="mb-4 text-gray-600">
            Each <code className="rounded bg-gray-200 px-1">route.tsx</code> file creates a layout
            that wraps all nested pages. Data flows <strong>flat</strong> through the tree, making
            it easy to share state.
          </p>
        </div>

        <div className="mb-6 rounded-lg bg-gray-50 p-6">
          <h3 className="mb-2 font-semibold text-lg">File-Based Routing</h3>
          <p className="mb-4 text-gray-600">Your file structure defines your routes:</p>
          <ul className="space-y-1 font-mono text-gray-600 text-sm">
            <li>
              <code className="rounded bg-gray-200 px-1">pages/index.tsx</code> →{" "}
              <code className="text-indigo-600">/</code>
            </li>
            <li>
              <code className="rounded bg-gray-200 px-1">pages/blog/[slug].tsx</code> →{" "}
              <code className="text-indigo-600">/blog/:slug</code>
            </li>
            <li>
              <code className="rounded bg-gray-200 px-1">pages/[...catch].tsx</code> →{" "}
              <code className="text-indigo-600">/*</code>
            </li>
          </ul>
        </div>

        <h2 className="mt-8 mb-4 font-bold text-2xl">This Demo</h2>
        <p className="mb-4 text-gray-600">
          This application demonstrates all of Elysion's features:
        </p>
        <ul className="space-y-2 text-gray-600">
          <li>SSG landing page (this page)</li>
          <li>SSR blog list with pagination</li>
          <li>ISR blog posts with 60-second revalidation</li>
          <li>Protected dashboard with nested layouts</li>
          <li>Full CRUD operations with SQLite</li>
        </ul>

        <div className="mt-8 rounded-lg bg-indigo-50 p-6">
          <h3 className="mb-2 font-semibold text-indigo-900 text-lg">Ready to explore?</h3>
          <div className="flex gap-4">
            <Link className="font-medium text-indigo-600 hover:text-indigo-700" to="/blog">
              Read the Blog →
            </Link>
            <Link className="font-medium text-indigo-600 hover:text-indigo-700" to="/dashboard">
              View Dashboard →
            </Link>
          </div>
        </div>
      </div>
    </div>
  ),
});
