import { createRoute } from "elysion/client";
import { queries } from "../../../db";
import { route as dashboardRoute } from "../route";

export const route = createRoute({
  parent: dashboardRoute,
  loader: () => {
    const posts = queries.getPosts.all();
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

export default route;
