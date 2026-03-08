import { Link } from "elyra/link";
import { type Post, parseTags, queries } from "../../db";
import { route } from "./_route";

type PostWithParsedTags = Omit<Post, "tags"> & { tags: string[] };

export default route.page({
  loader: ({ query }) => {
    const page = query.page || 1;
    const tag = query.tag;
    const perPage = 5;

    let posts: Post[];
    if (tag) {
      posts = queries.getPostsByTag.all(`%${tag}%`);
    } else {
      posts = queries.getPublishedPosts.all();
    }

    const total = posts.length;
    const totalPages = Math.ceil(total / perPage);
    const start = (page - 1) * perPage;
    const paginatedPosts: PostWithParsedTags[] = posts
      .slice(start, start + perPage)
      .map((p) => ({ ...p, tags: parseTags(p.tags) }));

    return {
      posts: paginatedPosts,
      pagination: {
        page,
        totalPages,
        total,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
      currentTag: tag || null,
    };
  },

  head: ({ currentTag }) => ({
    meta: [{ title: currentTag ? `${currentTag} - Blog` : "Blog - Elyra" }],
  }),

  component: ({ posts, pagination, currentTag }) => (
    <div>
      <div className="mb-8">
        <h1 className="font-bold text-3xl text-gray-900">
          {currentTag ? `Posts tagged "${currentTag}"` : "Blog"}
        </h1>
        <p className="mt-2 text-gray-600">
          Thoughts, tutorials, and insights about web development with Elyra.
        </p>
      </div>

      <div className="space-y-6">
        {posts.map((post) => (
          <PostCard key={post.id} post={post} />
        ))}
      </div>

      {posts.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-gray-500">No posts found.</p>
          <Link className="mt-2 inline-block text-indigo-600 hover:text-indigo-700" to="/blog">
            View all posts →
          </Link>
        </div>
      )}

      {pagination.totalPages > 1 && (
        <div className="mt-8 flex items-center justify-between border-gray-200 border-t pt-8">
          <div className="text-gray-500 text-sm">
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} posts)
          </div>
          <div className="flex gap-2">
            {pagination.hasPrev && (
              <Link
                className="rounded-md border border-gray-300 bg-white px-4 py-2 font-medium text-gray-700 text-sm hover:bg-gray-50"
                search={{
                  page: pagination.page - 1,
                  tag: currentTag ?? undefined,
                }}
                to="/blog"
              >
                Previous
              </Link>
            )}
            {pagination.hasNext && (
              <Link
                className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-sm text-white hover:bg-indigo-700"
                search={{
                  page: pagination.page + 1,
                  tag: currentTag ?? undefined,
                }}
                to="/blog"
              >
                Next
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  ),
});

function PostCard({ post }: { post: PostWithParsedTags }) {
  const tags = post.tags;
  const date = new Date(post.createdAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <article className="overflow-hidden rounded-lg border border-gray-200 bg-white transition-shadow hover:shadow-md">
      <Link className="block p-6" to={`/blog/${post.slug}`}>
        <h2 className="mb-2 font-semibold text-gray-900 text-xl transition-colors hover:text-indigo-600">
          {post.title}
        </h2>
        <p className="mb-4 text-gray-600">{post.excerpt}</p>
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            {tags.slice(0, 3).map((tag) => (
              <span
                className="rounded bg-indigo-100 px-2 py-1 font-medium text-indigo-700 text-xs"
                key={tag}
              >
                {tag}
              </span>
            ))}
          </div>
          <time className="text-gray-500 text-sm">{date}</time>
        </div>
      </Link>
    </article>
  );
}
