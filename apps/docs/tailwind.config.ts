import type { Config } from "tailwindcss";
import colors from "tailwindcss/colors";

export default {
  theme: {
    extend: {
      typography: {
        DEFAULT: {
          css: {
            // Code windows supply their own styles and opt out with `not-prose`.
            pre: null,
            "pre code": null,
            "pre code::before": null,
            "pre code::after": null,
            "--tw-prose-body": colors.slate[700],
            "--tw-prose-headings": colors.slate[900],
            "--tw-prose-lead": colors.slate[600],
            "--tw-prose-links": colors.slate[900],
            "--tw-prose-bold": colors.slate[900],
            "--tw-prose-counters": colors.slate[500],
            "--tw-prose-bullets": colors.slate[300],
            "--tw-prose-hr": colors.slate[200],
            "--tw-prose-quotes": colors.slate[900],
            "--tw-prose-quote-borders": colors.slate[200],
            "--tw-prose-captions": colors.slate[500],
            "--tw-prose-kbd": colors.slate[900],
            "--tw-prose-kbd-shadows": `color-mix(in oklab, ${colors.slate[900]} 10%, transparent)`,
            "--tw-prose-code": colors.slate[900],
            "--tw-prose-pre-code": null,
            "--tw-prose-pre-bg": null,
            "--tw-prose-th-borders": colors.slate[300],
            "--tw-prose-td-borders": colors.slate[200],
            "--tw-prose-invert-body": colors.slate[300],
            "--tw-prose-invert-headings": colors.white,
            "--tw-prose-invert-lead": colors.slate[400],
            "--tw-prose-invert-links": colors.white,
            "--tw-prose-invert-bold": colors.white,
            "--tw-prose-invert-counters": colors.slate[400],
            "--tw-prose-invert-bullets": colors.slate[600],
            "--tw-prose-invert-hr": colors.slate[700],
            "--tw-prose-invert-quotes": colors.slate[100],
            "--tw-prose-invert-quote-borders": colors.slate[700],
            "--tw-prose-invert-captions": colors.slate[400],
            "--tw-prose-invert-kbd": colors.white,
            "--tw-prose-invert-kbd-shadows": "rgb(255 255 255 / 10%)",
            "--tw-prose-invert-code": colors.white,
            "--tw-prose-invert-pre-code": null,
            "--tw-prose-invert-pre-bg": null,
            "--tw-prose-invert-th-borders": colors.slate[600],
            "--tw-prose-invert-td-borders": colors.slate[700],
          },
        },
      },
    },
  },
} satisfies Config;
