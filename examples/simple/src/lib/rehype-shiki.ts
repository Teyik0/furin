import { fromHtml } from "hast-util-from-html";
import { h } from "hastscript";
import { codeToHtml } from "shiki";
import { visitParents } from "unist-util-visit-parents";

const LANG_RE = /language-([\w-]+)/;
const FILE_COMMENT_RE = /^(?:\/\/|#)\s*([\w./\-[\]]+\.\w+)\s*\n/;

// biome-ignore lint/suspicious/noExplicitAny: hast node types
type HastNode = any;

const dot = (color: string) =>
  h("span", {
    style: `display:inline-block;width:12px;height:12px;border-radius:9999px;background:${color}`,
  });

const rehypeShiki = () => async (tree: HastNode) => {
  const tasks: Array<() => Promise<void>> = [];

  visitParents(tree, "element", (node: HastNode, ancestors: HastNode[]) => {
    if (node.tagName !== "code") {
      return;
    }
    const parent = ancestors.at(-1);
    if (!parent || parent.tagName !== "pre") {
      return;
    }

    // Detect if this code block is inside a <CodeTab> MDX element
    const isInCodeTab = ancestors.some(
      (a: HastNode) =>
        (a.type === "mdxJsxFlowElement" || a.type === "element") &&
        (a.name === "CodeTab" || a.tagName === "CodeTab")
    );

    const className: string[] = node.properties?.className ?? [];
    const lang = className.join(" ").match(LANG_RE)?.[1] ?? "text";
    const rawText: string = node.children[0]?.value ?? "";

    const fileMatch = rawText.match(FILE_COMMENT_RE);
    const title = fileMatch ? fileMatch[1] : lang;
    const text = fileMatch ? rawText.slice(fileMatch[0].length) : rawText;

    tasks.push(async () => {
      let html: string;
      try {
        html = await codeToHtml(text, { lang, theme: "github-dark" });
      } catch {
        // Unsupported language or Shiki error — render as plain text
        const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        html = `<pre><code>${escaped}</code></pre>`;
      }
      const fragment = fromHtml(html, { fragment: true });
      const shikiPre = fragment.children.find(
        (n: HastNode) => n.type === "element" && n.tagName === "pre"
      ) as HastNode;
      if (!shikiPre) {
        return;
      }

      shikiPre.properties = {
        ...shikiPre.properties,
        style: `${shikiPre.properties?.style ?? ""};margin:0;padding:1.25rem 1.5rem;font-size:0.875rem;line-height:1.7;overflow-x:auto`,
      };

      if (isInCodeTab) {
        // Inside a tab — just the highlighted <pre>, no window chrome
        parent._shikiReplacement = shikiPre;
      } else {
        // Standalone — full macOS terminal window
        const codeWindow = h(
          "div",
          {
            class:
              "not-prose my-6 overflow-hidden rounded-xl border border-slate-700/50 shadow-lg shadow-black/20",
          },
          [
            h(
              "div",
              {
                style:
                  "display:flex;align-items:center;gap:6px;padding:10px 16px;background:#161b22;border-bottom:1px solid rgba(99,102,241,0.15)",
              },
              [
                dot("rgba(239,68,68,0.8)"),
                dot("rgba(234,179,8,0.8)"),
                dot("rgba(34,197,94,0.8)"),
                h(
                  "span",
                  {
                    style:
                      "margin-left:8px;font-family:ui-monospace,monospace;font-size:0.75rem;color:#94a3b8",
                  },
                  title
                ),
              ]
            ),
            shikiPre,
          ]
        );
        parent._shikiReplacement = codeWindow;
      }
    });
  });

  await Promise.all(tasks.map((t) => t()));

  visitParents(tree, "element", (node: HastNode, ancestors: HastNode[]) => {
    const replacement = node._shikiReplacement;
    if (replacement) {
      const parent = ancestors.at(-1);
      if (parent) {
        const index = parent.children.indexOf(node);
        if (index !== -1) {
          parent.children[index] = replacement;
        }
      }
    }
  });
};

export default rehypeShiki;
