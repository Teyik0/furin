import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { codeToHtml } from "shiki";
import { client } from "@/client";
import { authClient } from "@/lib/auth-client";

const LANG_RE = /language-(\w+)/;
const TRAILING_NL_RE = /\n$/;

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    codeToHtml(code, { lang: lang || "text", theme: "github-dark" }).then((html) => {
      if (ref.current) {
        ref.current.innerHTML = html;
        const pre = ref.current.querySelector("pre");
        if (pre) {
          pre.style.outline = "none";
          pre.style.border = "none";
          pre.style.margin = "0";
          pre.style.overflowX = "auto";
          pre.removeAttribute("tabindex");
        }
      }
    });
  }, [code, lang]);

  return (
    <div
      className="not-prose overflow-hidden rounded-lg border-0 text-sm [&_*]:border-0 [&_*]:outline-none"
      ref={ref}
    >
      <pre className="bg-[#0d1117] p-4 font-mono outline-none">
        <code>{code}</code>
      </pre>
    </div>
  );
}

interface Comment {
  content: string;
  createdAt: Date | null;
  id: string;
  slug: string;
  userId: string;
  userImage: string | null;
  userName: string;
}

function formatDate(ts: Date | null) {
  if (!ts) {
    return "";
  }
  return new Date(ts).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function Avatar({ name, image }: { name: string; image: string | null }) {
  if (image) {
    return (
      <img
        alt={name}
        className="h-8 w-8 shrink-0 rounded-full"
        height={32}
        src={image}
        width={32}
      />
    );
  }
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 font-semibold text-sm text-white">
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

interface CommentsSectionProps {
  initialComments: Comment[];
  slug: string;
}

export function CommentsSection({ initialComments, slug }: CommentsSectionProps) {
  const { data: session } = authClient.useSession();

  const [comments, setComments] = useState<Comment[]>(initialComments);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setComments(initialComments);
    setError(null);
    setSubmitting(false);
    if (textareaRef.current) {
      textareaRef.current.value = "";
    }
  }, [initialComments]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const content = textareaRef.current?.value.trim();
    if (!content) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const { data: newComment, error: postError } = await client.api.comments.post({
        slug,
        content,
      });

      if (postError || !newComment) {
        setError("Failed to post comment.");
        return;
      }

      setComments((prev) => [...prev, newComment as Comment]);
      if (textareaRef.current) {
        textareaRef.current.value = "";
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to post comment.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-16 border-border border-t pt-8">
      <h2 className="mb-6 font-semibold text-lg">Comments</h2>

      {/* Comment list */}
      {comments.length === 0 && (
        <p className="text-muted-foreground text-sm">No comments yet. Be the first!</p>
      )}
      {comments.length > 0 && (
        <ul className="mb-8 space-y-6">
          {comments.map((c) => (
            <li className="flex gap-3" key={c.id}>
              <Avatar image={c.userImage} name={c.userName} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium text-sm">{c.userName}</span>
                  <span className="text-muted-foreground text-xs">{formatDate(c.createdAt)}</span>
                </div>
                <div className="prose prose-sm prose-slate dark:prose-invert mt-1 max-w-none">
                  <Markdown
                    components={{
                      code({ children, className }) {
                        const lang = className?.match(LANG_RE)?.[1] ?? "";
                        if (className) {
                          return (
                            <CodeBlock
                              code={String(children).replace(TRAILING_NL_RE, "")}
                              lang={lang}
                            />
                          );
                        }
                        return (
                          <code className="rounded bg-muted px-1 font-mono text-sm">
                            {children}
                          </code>
                        );
                      },
                    }}
                    remarkPlugins={[remarkGfm]}
                  >
                    {c.content}
                  </Markdown>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Form / CTA */}
      {session?.user ? (
        <form className="space-y-3" onSubmit={handleSubmit}>
          <div className="flex gap-3">
            <Avatar image={session.user.image ?? null} name={session.user.name} />
            <textarea
              className="min-h-[80px] w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-blue-600"
              disabled={submitting}
              placeholder="Leave a comment…"
              ref={textareaRef}
              rows={3}
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <div className="flex justify-end">
            <button
              className="rounded-full bg-blue-600 px-5 py-2 font-medium text-sm text-white transition-all hover:bg-blue-500 disabled:opacity-50"
              disabled={submitting}
              type="submit"
            >
              {submitting ? "Posting…" : "Post comment"}
            </button>
          </div>
        </form>
      ) : (
        <a
          className="inline-flex items-center rounded-full bg-blue-600 px-5 py-2 font-medium text-sm text-white transition-all hover:bg-blue-500"
          href="/login"
        >
          Sign in to comment
        </a>
      )}
    </div>
  );
}
