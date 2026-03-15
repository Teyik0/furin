import { Link } from "@teyik0/furin/link";
import { useState } from "react";
import { route } from "./_route";

export default route.page({
  head: () => ({ meta: [{ title: "New Post - Dashboard" }] }),
  component: () => {
    const [title, setTitle] = useState("");
    const [excerpt, setExcerpt] = useState("");
    const [content, setContent] = useState("");
    const [tags, setTags] = useState("");
    const [published, setPublished] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const handleSubmit = async (e: React.SubmitEvent) => {
      e.preventDefault();
      setSaving(true);
      setError("");

      try {
        const response = await fetch("/api/posts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, excerpt, content, tags, published }),
        });

        const data = (await response.json()) as {
          success: boolean;
          error?: string;
          post?: { id: string };
        };

        if (data.success && data.post) {
          location.href = `/dashboard/posts/${data.post.id}/edit`;
        } else {
          setError(data.error || "Failed to create post");
        }
      } catch {
        setError("Network error");
      } finally {
        setSaving(false);
      }
    };

    return (
      <div className="max-w-3xl">
        <div className="mb-6">
          <Link className="text-indigo-600 text-sm hover:text-indigo-700" to="/dashboard">
            ← Back to Posts
          </Link>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="mb-6 font-semibold text-gray-900 text-lg">Create New Post</h3>

          <form className="space-y-6" onSubmit={handleSubmit}>
            {error && <div className="rounded-lg bg-red-50 p-4 text-red-700 text-sm">{error}</div>}

            <div>
              <label className="mb-1 block font-medium text-gray-700 text-sm" htmlFor="title">
                Title
              </label>
              <input
                className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                id="title"
                onChange={(e) => setTitle(e.currentTarget.value)}
                required
                type="text"
                value={title}
              />
            </div>

            <div>
              <label className="mb-1 block font-medium text-gray-700 text-sm" htmlFor="excerpt">
                Excerpt
              </label>
              <input
                className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                id="excerpt"
                onChange={(e) => setExcerpt(e.currentTarget.value)}
                required
                type="text"
                value={excerpt}
              />
            </div>

            <div>
              <label className="mb-1 block font-medium text-gray-700 text-sm" htmlFor="content">
                Content (Markdown)
              </label>
              <textarea
                className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                id="content"
                onChange={(e) => setContent(e.currentTarget.value)}
                required
                rows={12}
                value={content}
              />
            </div>

            <div>
              <label className="mb-1 block font-medium text-gray-700 text-sm" htmlFor="tags">
                Tags (comma-separated)
              </label>
              <input
                className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                id="tags"
                onChange={(e) => setTags(e.currentTarget.value)}
                placeholder="react, typescript, web"
                type="text"
                value={tags}
              />
            </div>

            <div className="flex items-center">
              <input
                checked={published}
                className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                id="published"
                onChange={(e) => setPublished(e.currentTarget.checked)}
                type="checkbox"
              />
              <label className="ml-2 block text-gray-900 text-sm" htmlFor="published">
                Publish immediately
              </label>
            </div>

            <div className="flex justify-end gap-3">
              <Link
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-gray-700 hover:bg-gray-50"
                to="/dashboard"
              >
                Cancel
              </Link>
              <button
                className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                disabled={saving}
                type="submit"
              >
                {saving ? "Creating..." : "Create Post"}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  },
});
