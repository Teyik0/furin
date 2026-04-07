import { beforeAll, describe, expect, it } from "bun:test";
import { extname, relative, resolve } from "node:path";
import { renderEjsFile } from "../src/engine/renderer";
import type { EjsTemplateVars } from "../src/pipeline/context";

const SCAFFOLDER_ROOT = resolve(import.meta.dir, "..");
const TEMPLATES_DIR = resolve(SCAFFOLDER_ROOT, "templates");
const TOKEN_RE = /\{\{[A-Z_]+\}\}/;
/** Matches strings that are absolute paths (start with / or \). */
const ABSOLUTE_PATH_RE = /^[/\\]/;

// Known binary file extensions — these must not be decoded as text and scanned.
const BINARY_EXTENSIONS = new Set([
  ".ico",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
]);

/** Minimal EJS vars sufficient to render any scaffolder template without errors. */
const MOCK_EJS_VARS: EjsTemplateVars = {
  projectName: "test-app",
  projectNameKebab: "test-app",
  projectNamePascal: "TestApp",
  furinVersion: "0.0.0",
  features: ["tailwind", "shadcn"],
  versions: new Proxy({} as Record<string, string>, {
    get: () => "0.0.0",
  }),
};

interface ManifestFile {
  dest: string;
  kind: "ejs" | "static";
  src: string;
}

interface TemplateDefinition {
  files: ManifestFile[];
  id: string;
  label: string;
}

interface ManifestRegistry {
  templates: TemplateDefinition[];
  version: number;
}

let registry: ManifestRegistry;

beforeAll(async () => {
  const manifestPath = resolve(TEMPLATES_DIR, "manifest.json");
  const content = await Bun.file(manifestPath).text();
  registry = JSON.parse(content) as ManifestRegistry;
});

describe("manifest.json integrity", () => {
  it("parses manifest.json without errors", () => {
    expect(registry.version).toBe(2);
    expect(Array.isArray(registry.templates)).toBe(true);
  });

  it("contains exactly 2 templates: simple and full", () => {
    const ids = registry.templates.map((t) => t.id);
    expect(ids).toContain("simple");
    expect(ids).toContain("full");
    expect(ids).toHaveLength(2);
  });

  it("ships a default public/favicon.ico for each template", () => {
    for (const template of registry.templates) {
      expect(template.files.some((file) => file.dest === "public/favicon.ico")).toBe(true);
    }
  });
});

describe("template files — all src paths exist on disk and stay within roots", () => {
  it("all simple template files exist and are in-bounds", async () => {
    const simpleTemplate = registry.templates.find((t) => t.id === "simple");
    expect(simpleTemplate).toBeDefined();
    if (!simpleTemplate) {
      throw new Error("Missing simple template");
    }

    for (const file of simpleTemplate.files) {
      // src must resolve inside TEMPLATES_DIR
      const absoluteSrc = resolve(TEMPLATES_DIR, file.src);
      const relSrc = relative(TEMPLATES_DIR, absoluteSrc);
      expect(relSrc.startsWith(".."), `src escapes templates/: ${file.src}`).toBe(false);
      expect(relSrc, `src must not be absolute: ${file.src}`).not.toMatch(ABSOLUTE_PATH_RE);

      // dest must not escape the project root (no leading .. or absolute path)
      const relDest = relative("/", resolve("/", file.dest));
      expect(relDest.startsWith(".."), `dest escapes project root: ${file.dest}`).toBe(false);
      expect(relDest, `dest must not be absolute: ${file.dest}`).not.toMatch(ABSOLUTE_PATH_RE);

      const exists = await Bun.file(absoluteSrc).exists();
      expect(exists, `Missing: templates/${file.src}`).toBe(true);
    }
  });

  it("all full template files exist and are in-bounds", async () => {
    const fullTemplate = registry.templates.find((t) => t.id === "full");
    expect(fullTemplate).toBeDefined();
    if (!fullTemplate) {
      throw new Error("Missing full template");
    }

    for (const file of fullTemplate.files) {
      const absoluteSrc = resolve(TEMPLATES_DIR, file.src);
      const relSrc = relative(TEMPLATES_DIR, absoluteSrc);
      expect(relSrc.startsWith(".."), `src escapes templates/: ${file.src}`).toBe(false);
      expect(relSrc, `src must not be absolute: ${file.src}`).not.toMatch(ABSOLUTE_PATH_RE);

      const relDest = relative("/", resolve("/", file.dest));
      expect(relDest.startsWith(".."), `dest escapes project root: ${file.dest}`).toBe(false);
      expect(relDest, `dest must not be absolute: ${file.dest}`).not.toMatch(ABSOLUTE_PATH_RE);

      const exists = await Bun.file(absoluteSrc).exists();
      expect(exists, `Missing: templates/${file.src}`).toBe(true);
    }
  });
});

describe("EJS files render without errors and leave no raw tags", () => {
  it("every .ejs file renders cleanly with mock vars", async () => {
    for (const template of registry.templates) {
      for (const file of template.files) {
        if (file.kind !== "ejs") {
          continue;
        }
        const absolutePath = resolve(TEMPLATES_DIR, file.src);
        const rendered = await renderEjsFile(absolutePath, MOCK_EJS_VARS);
        expect(rendered, `Leftover EJS open-tag in ${file.src} after rendering`).not.toContain(
          "<%"
        );
        expect(rendered, `Leftover EJS close-tag in ${file.src} after rendering`).not.toContain(
          "%>"
        );
      }
    }
  });
});

describe("static files — no EJS-like tokens", () => {
  it("static files do not contain raw {{TOKEN}} strings", async () => {
    for (const template of registry.templates) {
      for (const file of template.files) {
        if (file.kind !== "static") {
          continue;
        }
        // Skip binary files — decoding them as UTF-8 text is incorrect and
        // the TOKEN_RE pattern cannot meaningfully appear in binary data.
        if (BINARY_EXTENSIONS.has(extname(file.src).toLowerCase())) {
          continue;
        }
        const absolutePath = resolve(TEMPLATES_DIR, file.src);
        const fileContent = await Bun.file(absolutePath).text();
        const hasTokens = TOKEN_RE.test(fileContent);
        expect(hasTokens, `Unexpected {{TOKEN}} in static file ${file.src}`).toBe(false);
      }
    }
  });
});

describe("full template UI files", () => {
  it("sets a safe default button type", async () => {
    const src = resolve(TEMPLATES_DIR, "full/src/components/ui/button.tsx");
    const raw = await Bun.file(src).text();
    expect(raw).toContain('type: type ?? "button"');
  });
});

describe("package.json.ejs files — valid JSON after actual EJS rendering", () => {
  it("simple/package.json.ejs renders to valid JSON", async () => {
    const src = resolve(TEMPLATES_DIR, "simple/package.json.ejs");
    const rendered = await renderEjsFile(src, MOCK_EJS_VARS);
    expect(() => JSON.parse(rendered)).not.toThrow();
    const parsed = JSON.parse(rendered);
    expect(typeof parsed.name).toBe("string");
  });

  it("full/package.json.ejs renders to valid JSON", async () => {
    const src = resolve(TEMPLATES_DIR, "full/package.json.ejs");
    const rendered = await renderEjsFile(src, MOCK_EJS_VARS);
    expect(() => JSON.parse(rendered)).not.toThrow();
    const parsed = JSON.parse(rendered);
    expect(typeof parsed.name).toBe("string");
  });
});
