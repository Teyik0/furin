import { createRoute } from "elyra/client";
import { t } from "elysia";
import { useState } from "react";
import { type Comment, type Post, parseTags, queries } from "../../db";

type PostWithParsedTags = Omit<Post, "tags"> & { tags: string[] };

import { route as blogRoute } from "./route";

export const route = createRoute({
  parent: blogRoute,
  params: t.Object({ slug: t.String() }),
  mode: "ssg",
});

export default route.page({
  // Pre-renders every published post on server start (production only).
  // In dev the cache is skipped so you always get fresh content.
  staticParams: () => queries.getPublishedPosts.all().map((p) => ({ slug: p.slug })),

  loader: ({ params: { slug } }) => {
    const post = queries.getPostBySlug.get(slug);
    if (!post) {
      throw new Error("Post not found");
    }
    const comments = queries.getCommentsByPostId.all(post.id);
    const postWithTags: PostWithParsedTags = {
      ...post,
      tags: parseTags(post.tags),
    };
    return { post: postWithTags, comments };
  },

  head: ({ post }) => ({
    meta: [{ title: `${post.title} - Elyra Blog` }],
  }),

  component: ({ post, comments }: { post: PostWithParsedTags; comments: Comment[] }) => {
    const [commentList, setCommentList] = useState(comments);

    const handleAddComment = async (author: string, content: string) => {
      const response = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId: post.id, author, content }),
      });
      const data = (await response.json()) as {
        success: boolean;
        comment: Comment;
      };
      if (data.success) {
        setCommentList((prev) => [data.comment, ...prev]);
      }
    };

    return (
      <div>
        <article>
          <header className="mb-8">
            <a
              className="mb-4 inline-block font-medium text-indigo-600 text-sm hover:text-indigo-700"
              href="/blog"
            >
              ← Back to Blog
            </a>
            <h1 className="mb-4 font-bold text-4xl text-gray-900">{post.title}</h1>
            <div className="flex items-center gap-4 text-gray-500 text-sm">
              <time>
                {new Date(post.createdAt).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </time>
              <span>•</span>
              <span>SSG (pre-rendered)</span>
            </div>
            <div className="mt-4 flex gap-2">
              {post.tags.map((tag) => (
                <a
                  className="rounded bg-indigo-100 px-3 py-1 text-indigo-700 text-sm transition-colors hover:bg-indigo-200"
                  href={`/blog?tag=${encodeURIComponent(tag)}`}
                  key={tag}
                >
                  {tag}
                </a>
              ))}
            </div>
          </header>

          <div className="prose prose-lg mb-12 max-w-none">
            <MarkdownContent content={post.content} />
          </div>
        </article>

        <section className="border-gray-200 border-t pt-8">
          <h2 className="mb-6 font-bold text-2xl">Comments ({commentList.length})</h2>
          <CommentForm onSubmit={handleAddComment} />
          <div className="mt-6 space-y-4">
            {commentList.map((comment) => (
              <CommentCard comment={comment} key={comment.id} />
            ))}
            {commentList.length === 0 && (
              <p className="py-8 text-center text-gray-500">
                No comments yet. Be the first to comment!
              </p>
            )}
          </div>
        </section>
      </div>
    );
  },
});

function MarkdownContent({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeContent = "";
  let key = 0;

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        inCodeBlock = false;
        elements.push(
          <pre
            className="my-4 overflow-x-auto rounded-lg bg-gray-900 p-4 text-gray-100"
            key={key++}
          >
            <code>{codeContent}</code>
          </pre>
        );
      } else {
        inCodeBlock = true;
        codeContent = "";
      }
      continue;
    }

    if (inCodeBlock) {
      codeContent += `${line}\n`;
      continue;
    }

    if (line.startsWith("# ")) {
      elements.push(
        <h1 className="mt-8 mb-4 font-bold text-3xl" key={key++}>
          {line.slice(2)}
        </h1>
      );
    } else if (line.startsWith("## ")) {
      elements.push(
        <h2 className="mt-6 mb-3 font-semibold text-2xl" key={key++}>
          {line.slice(3)}
        </h2>
      );
    } else if (line.startsWith("### ")) {
      elements.push(
        <h3 className="mt-4 mb-2 font-semibold text-xl" key={key++}>
          {line.slice(4)}
        </h3>
      );
    } else if (line.startsWith("- ")) {
      elements.push(
        <li className="ml-6" key={key++}>
          {line.slice(2)}
        </li>
      );
    } else if (line.trim() === "") {
      elements.push(<br key={key++} />);
    } else {
      elements.push(
        <p className="my-2" key={key++}>
          {line}
        </p>
      );
    }
  }

  return <>{elements}</>;
}

function CommentForm({ onSubmit }: { onSubmit: (author: string, content: string) => void }) {
  const [author, setAuthor] = useState("");
  const [content, setContent] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (author.trim() && content.trim()) {
      onSubmit(author, content);
      setContent("");
    }
  };

  return (
    <form className="rounded-lg bg-gray-50 p-4" onSubmit={handleSubmit}>
      <div className="mb-3">
        <input
          className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          onChange={(e) => setAuthor(e.currentTarget.value)}
          placeholder="Your name"
          required
          type="text"
          value={author}
        />
      </div>
      <div className="mb-3">
        <textarea
          className="min-h-20 w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          onChange={(e) => setContent(e.currentTarget.value)}
          placeholder="Write a comment..."
          required
          value={content}
        />
      </div>
      <button
        className="rounded-md bg-indigo-600 px-4 py-2 text-white transition-colors hover:bg-indigo-700"
        type="submit"
      >
        Post Comment
      </button>
    </form>
  );
}

function CommentCard({ comment }: { comment: Comment }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-gray-900">{comment.author}</span>
        <time className="text-gray-500 text-sm">
          {new Date(comment.createdAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
        </time>
      </div>
      <p className="text-gray-600">{comment.content}</p>
    </div>
  );
}
