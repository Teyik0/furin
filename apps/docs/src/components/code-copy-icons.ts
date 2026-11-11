import { h } from "hastscript";
import { COPY_ICON_PATH, COPY_ICON_RECT } from "./code-copy-icon-shape";

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
  [h("rect", COPY_ICON_RECT), h("path", { d: COPY_ICON_PATH })]
);

export { icon as copyIcon };
