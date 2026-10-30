import { h } from "hastscript";

// Shared by the rehype-highlight code windows and the CodeTabs component so
// both render byte-identical markup for the delegated copy bridge.
const icon: ReturnType<typeof h> = h(
  "svg",
  {
    "aria-hidden": "true",
    fill: "none",
    stroke: "currentColor",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "stroke-width": "2",
    style: "width:0.85rem;height:0.85rem",
    viewBox: "0 0 24 24",
  },
  [
    h("rect", { height: "14", rx: "2", ry: "2", width: "14", x: "8", y: "8" }),
    h("path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }),
  ]
);

export { icon as copyIcon };
