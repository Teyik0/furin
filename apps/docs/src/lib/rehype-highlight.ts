import { tokensToHast } from "@tanstack/highlight/markdown";
import { h } from "hastscript";
import { visitParents } from "unist-util-visit-parents";
import { copyIcon } from "../components/code-copy-icons";
import { highlighter } from "./highlight";

const LANG_RE = /language-([\w-]+)/;
const FILE_COMMENT_RE = /^(?:\/\/|#)\s*([\w./\-[\]]+\.\w+)\s*\n/;

// biome-ignore lint/suspicious/noExplicitAny: hast node types
type HastNode = any;

// Copy buttons are inert in the generated markup: a single delegated document
// listener (code-copy-bridge.tsx) performs the clipboard write.
const copyButton = () =>
  h(
    "button",
    {
      "aria-label": "Copy code",
      "data-code-copy": "",
      type: "button",
    },
    [copyIcon]
  );

const rehypeHighlight = () => (tree: HastNode) => {
  visitParents(tree, "element", (node: HastNode, ancestors: HastNode[]) => {
    if (node.tagName !== "code") {
      return;
    }
    const parent = ancestors.at(-1);
    if (parent?.tagName !== "pre") {
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
    const rawText: string = node.children
      .map((child: HastNode) => (child.type === "text" ? child.value : ""))
      .join("");

    const fileMatch = rawText.match(FILE_COMMENT_RE);
    const title = fileMatch?.[1] ?? lang;
    const text = fileMatch ? rawText.slice(fileMatch[0].length) : rawText;

    const highlighted = highlighter.tokenize(text, { lang });
    const highlightedPre = tokensToHast(highlighted.tokens, highlighted.lang) as ReturnType<
      typeof h
    >;

    highlightedPre.properties = {
      ...highlightedPre.properties,
      style: "margin:0;padding:1.25rem 1.5rem;font-size:0.8125rem;line-height:1.7;overflow-x:auto",
    };

    if (isInCodeTab) {
      // Inside a tab — just the highlighted <pre>, no window chrome
      parent._highlightReplacement = highlightedPre;
    } else {
      const codeWindow = h("div", { class: "not-prose workbench-code-window" }, [
        h("div", { class: "workbench-code-header" }, [
          h("span", title),
          h("span", { class: "workbench-code-language" }, lang.toUpperCase()),
          copyButton(),
        ]),
        highlightedPre,
      ]);
      parent._highlightReplacement = codeWindow;
    }
  });

  visitParents(tree, "element", (node: HastNode, ancestors: HastNode[]) => {
    const replacement = node._highlightReplacement;
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

export default rehypeHighlight;
