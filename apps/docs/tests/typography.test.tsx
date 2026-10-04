import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import { renderToStaticMarkup } from "react-dom/server";
import { createTmpApp } from "../../../packages/core/tests/support/app-fixtures";
import { DocPage } from "../src/components/doc-page";

function palette(css: string, selector: string): { [variable: string]: string } {
  const block = css.match(new RegExp(`\\.${selector}\\{([^}]*)}`))?.[1];
  if (block === undefined) {
    throw new Error(`Missing typography selector .${selector}`);
  }
  return Object.fromEntries(
    [...block.matchAll(/(--tw-prose-[\w-]+):([^;]+)(?:;|$)/g)].map(([, name, value]) => [
      name,
      value,
    ])
  );
}

test("SSR docs use the exact Slate typography palette in light and dark mode", async () => {
  const app = createTmpApp("cli-app");
  try {
    const entry = join(app.path, "typography.css");
    writeFileSync(
      entry,
      `@import ${JSON.stringify(resolve(import.meta.dir, "../src/pages/globals.css"))};\n@source inline("prose-slate");`
    );
    const build = await Bun.build({ entrypoints: [entry], minify: true, plugins: [tailwind] });
    expect(build.success).toBe(true);
    const output = build.outputs.find((file) => file.path.endsWith(".css"));
    if (output === undefined) {
      throw new Error("Missing docs typography CSS");
    }
    const css = await output.text();
    const slate = Object.fromEntries(
      Object.entries(palette(css, "prose-slate")).filter(([variable]) => !variable.includes("pre-"))
    );
    expect(Object.keys(slate)).toHaveLength(32);
    expect(palette(css, "prose")).toEqual(slate);
    expect(css).toContain("--tw-prose-body:var(--tw-prose-invert-body)");
    const html = renderToStaticMarkup(
      <DocPage
        doc={{
          description: "",
          githubPath: "",
          href: "/docs/routing",
          label: "Routing",
          openIn: [],
          sourcePath: "",
          title: "Routing",
        }}
        markdownSource="Color contract"
      >
        <p>Color contract</p>
      </DocPage>
    );
    expect(html).toContain('class="doc-content prose dark:prose-invert max-w-none"');
    expect(html).toContain("<p>Color contract</p>");
  } finally {
    app.cleanup();
  }
});
