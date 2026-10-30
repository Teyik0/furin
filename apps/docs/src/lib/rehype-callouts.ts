/**
 * GitHub-style alert conversions for callouts:
 *
 *   > [!NOTE]
 *   > Body text.
 *
 * The blockquote becomes a styled `.callout` element with a titled header,
 * handled by the callout styles in globals.css and rendered directly by the
 * server (no client component involved).
 */
import { h } from "hastscript";
import { visitParents } from "unist-util-visit-parents";

// biome-ignore lint/suspicious/noExplicitAny: hast node types
type HastNode = any;

interface CalloutMeta {
  className: string;
  icon: HastNode;
  title: string;
}

const CALLOUTS: { readonly [kind: string]: CalloutMeta | undefined } = {
  CAUTION: {
    className: "callout-caution",
    icon: icon(
      "M12 8v4M12 15h.01",
      "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
    ),
    title: "Caution",
  },
  IMPORTANT: {
    className: "callout-important",
    icon: icon("M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"),
    title: "Important",
  },
  NOTE: {
    className: "callout-note",
    icon: icon("M12 16v-4M12 8h.01", "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z"),
    title: "Note",
  },
  TIP: {
    className: "callout-tip",
    icon: icon(
      "M9 18h6M10 22h4",
      "M15.09 14c.18-.98.65-1.74 1.41-2.5A4.4 4.4 0 0 0 18 8a6 6 0 0 0-12 0c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5"
    ),
    title: "Tip",
  },
  WARNING: {
    className: "callout-warning",
    icon: icon(
      "M12 9v4M12 17h.01",
      "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
    ),
    title: "Warning",
  },
};

const ALERT_KIND_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/;

const LEADING_MARKER_RE = /^\[!/;
const TRAILING_MARKER_RE = /\]$/;

function icon(...paths: string[]): HastNode {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      class: "callout-icon",
      fill: "none",
      stroke: "currentColor",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "stroke-width": "2",
      viewBox: "0 0 24 24",
    },
    paths.map((path) => h("path", { d: path }))
  );
}

/**
 * Returns the paragraph that carries the alert marker, skipping the
 * whitespace-only text nodes remark emits between markdown blocks, or
 * undefined when the quote is plain prose.
 */
function findMarkerParagraph(node: HastNode): HastNode | undefined {
  for (const child of node.children) {
    if (child.tagName === "p") {
      return child;
    }
    if (child.type === "text" && child.value.trim() !== "") {
      // Loose prose before the first paragraph: not an alert.
      return undefined;
    }
  }
  return undefined;
}

function transformBlockquote(node: HastNode): void {
  const markerParagraph = findMarkerParagraph(node);
  const head = markerParagraph?.children[0];
  if (!markerParagraph || head?.type !== "text") {
    return;
  }

  // The alert marker must own the first line of the quote.
  const lineEnd = head.value.indexOf("\n");
  const markerLine = (lineEnd === -1 ? head.value : head.value.slice(0, lineEnd)).trimEnd();
  if (!ALERT_KIND_RE.test(markerLine)) {
    return;
  }
  const kind = markerLine.replace(LEADING_MARKER_RE, "").replace(TRAILING_MARKER_RE, "");
  const meta = CALLOUTS[kind];
  if (meta === undefined) {
    return;
  }

  head.value = head.value.slice(markerLine === head.value ? head.value.length : lineEnd + 1);
  if (head.value.length === 0) {
    markerParagraph.children.shift();
  }
  const keepMarkerParagraph = markerParagraph.children.length > 0;
  const body = keepMarkerParagraph
    ? node.children
    : [...node.children].filter((child) => child !== markerParagraph);

  node.tagName = "div";
  node.properties = {
    ...node.properties,
    className: ["callout", meta.className],
  };
  node.children = [
    h("p", { class: "callout-title" }, [meta.icon, h("span", [meta.title])]),
    ...body,
  ];
}

export function rehypeCallouts() {
  return (tree: HastNode) => {
    visitParents(tree, "element", (node: HastNode) => {
      if (node.tagName === "blockquote") {
        transformBlockquote(node);
      }
    });
  };
}
