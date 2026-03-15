import { createRoute } from "@teyik0/furin/client";
import { queries } from "../../../db";
import { route as dashboardRoute } from "../_route";

export const route = createRoute({
  parent: dashboardRoute,
  loader: async (_ctx, deps) => {
    // This loader starts immediately in parallel with dashboard/route.tsx (auth check).
    // deps() suspends only when the user data is actually needed.
    const { user } = await deps(dashboardRoute);
    // Admins see all posts (including drafts); regular users see published only.
    const posts = user?.role === "admin" ? queries.getPosts.all() : queries.getPublishedPosts.all();
    return { posts };
  },
  layout: ({ children }) => (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="font-bold text-2xl text-gray-900">Posts</h2>
        <a
          className="rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white transition-colors hover:bg-indigo-700"
          href="/dashboard/posts/new"
        >
          New Post
        </a>
      </div>
      {children}
    </div>
  ),
});
