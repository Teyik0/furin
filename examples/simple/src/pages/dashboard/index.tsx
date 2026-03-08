import { queries } from "../../db";
import { route } from "./_route";

export default route.page({
  loader: () => {
    const allPosts = queries.getPosts.all();
    const publishedPosts = allPosts.filter((p) => p.published);
    const draftPosts = allPosts.filter((p) => !p.published);
    const users = queries.getUsers.all();

    return {
      stats: {
        totalPosts: allPosts.length,
        publishedPosts: publishedPosts.length,
        draftPosts: draftPosts.length,
        totalUsers: users.length,
      },
      recentPosts: allPosts.slice(0, 5),
    };
  },

  component: ({ user, stats, recentPosts }) => (
    <div>
      <div className="mb-8">
        <h2 className="font-bold text-2xl text-gray-900">Welcome back, {user?.name}!</h2>
        <p className="text-gray-600">Here's what's happening with your blog.</p>
      </div>

      <div className="mb-8 grid grid-cols-1 gap-6 md:grid-cols-4">
        <StatCard color="indigo" icon="document" title="Total Posts" value={stats.totalPosts} />
        <StatCard color="green" icon="check" title="Published" value={stats.publishedPosts} />
        <StatCard color="yellow" icon="edit" title="Drafts" value={stats.draftPosts} />
        <StatCard color="purple" icon="users" title="Users" value={stats.totalUsers} />
      </div>

      <div className="rounded-lg border border-gray-200 bg-white">
        <div className="border-gray-200 border-b px-6 py-4">
          <h3 className="font-semibold text-gray-900">Recent Posts</h3>
        </div>

        <div className="divide-y divide-gray-200">
          {recentPosts.map((post) => (
            <div className="flex items-center justify-between px-6 py-4" key={post.id}>
              <div>
                <h4 className="font-medium text-gray-900">{post.title}</h4>
                <p className="text-gray-500 text-sm">
                  {new Date(post.createdAt).toLocaleDateString("en-CA")}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`rounded px-2 py-1 font-medium text-xs ${
                    post.published ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"
                  }`}
                >
                  {post.published ? "Published" : "Draft"}
                </span>
                <a
                  className="font-medium text-indigo-600 text-sm hover:text-indigo-700"
                  href={`/dashboard/posts/${post.id}/edit`}
                >
                  Edit
                </a>
              </div>
            </div>
          ))}
        </div>

        <div className="border-gray-200 border-t px-6 py-4">
          <a
            className="font-medium text-indigo-600 text-sm hover:text-indigo-700"
            href="/dashboard/posts"
          >
            View all posts →
          </a>
        </div>
      </div>
    </div>
  ),
});

function StatCard({
  title,
  value,
  icon,
  color,
}: {
  title: string;
  value: number;
  icon: string;
  color: string;
}) {
  const colors: Record<string, { bg: string; text: string }> = {
    indigo: { bg: "bg-indigo-100", text: "text-indigo-600" },
    green: { bg: "bg-green-100", text: "text-green-600" },
    yellow: { bg: "bg-yellow-100", text: "text-yellow-600" },
    purple: { bg: "bg-purple-100", text: "text-purple-600" },
  };

  const icons: Record<string, React.ReactNode> = {
    document: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <title>document</title>
        <path
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
      </svg>
    ),
    check: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <title>check</title>
        <path
          d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
      </svg>
    ),
    edit: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <title>edit</title>
        <path
          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
      </svg>
    ),
    users: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <title>users</title>
        <path
          d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
      </svg>
    ),
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-gray-500 text-sm">{title}</p>
          <p className="font-bold text-2xl text-gray-900">{value}</p>
        </div>
        <div
          className={`h-12 w-12 rounded-lg ${colors[color]?.bg} ${colors[color]?.text} flex items-center justify-center`}
        >
          {icons[icon]}
        </div>
      </div>
    </div>
  );
}
