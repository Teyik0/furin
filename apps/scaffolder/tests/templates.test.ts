import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

const SCAFFOLDER_ROOT = resolve(import.meta.dir, "..");
const TEMPLATES_DIR = resolve(SCAFFOLDER_ROOT, "templates");
const TOKEN_RE = /\{\{[A-Z_]+\}\}/;

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

describe("manifest.json integrity", () => {
  let registry: ManifestRegistry;

  it("parses manifest.json without errors", async () => {
    const manifestPath = resolve(TEMPLATES_DIR, "manifest.json");
    const content = await Bun.file(manifestPath).text();
    registry = JSON.parse(content) as ManifestRegistry;
    expect(registry.version).toBe(2);
    expect(Array.isArray(registry.templates)).toBe(true);
  });

  it("contains exactly 2 templates: simple and full", async () => {
    const manifestPath = resolve(TEMPLATES_DIR, "manifest.json");
    const content = await Bun.file(manifestPath).text();
    registry = JSON.parse(content) as ManifestRegistry;
    const ids = registry.templates.map((t) => t.id);
    expect(ids).toContain("simple");
    expect(ids).toContain("full");
    expect(ids).toHaveLength(2);
  });

  it("ships a default public/favicon.ico for each template", async () => {
    const manifestPath = resolve(TEMPLATES_DIR, "manifest.json");
    const content = await Bun.file(manifestPath).text();
    registry = JSON.parse(content) as ManifestRegistry;

    for (const template of registry.templates) {
      expect(template.files.some((file) => file.dest === "public/favicon.ico")).toBe(true);
    }
  });
});

describe("template files — all src paths exist on disk", () => {
  it("all simple template files exist", async () => {
    const manifestPath = resolve(TEMPLATES_DIR, "manifest.json");
    const content = await Bun.file(manifestPath).text();
    const registry = JSON.parse(content) as ManifestRegistry;
    const simpleTemplate = registry.templates.find((t) => t.id === "simple");
    expect(simpleTemplate).toBeDefined();
    if (!simpleTemplate) {
      throw new Error("Missing simple template");
    }

    for (const file of simpleTemplate.files) {
      const absolutePath = resolve(TEMPLATES_DIR, file.src);
      const exists = await Bun.file(absolutePath).exists();
      expect(exists, `Missing: templates/${file.src}`).toBe(true);
    }
  });

  it("all full template files exist", async () => {
    const manifestPath = resolve(TEMPLATES_DIR, "manifest.json");
    const content = await Bun.file(manifestPath).text();
    const registry = JSON.parse(content) as ManifestRegistry;
    const fullTemplate = registry.templates.find((t) => t.id === "full");
    expect(fullTemplate).toBeDefined();
    if (!fullTemplate) {
      throw new Error("Missing full template");
    }

    for (const file of fullTemplate.files) {
      const absolutePath = resolve(TEMPLATES_DIR, file.src);
      const exists = await Bun.file(absolutePath).exists();
      expect(exists, `Missing: templates/${file.src}`).toBe(true);
    }
  });
});

describe("EJS files have valid EJS syntax", () => {
  it("no .ejs file contains unclosed tags", async () => {
    const manifestPath = resolve(TEMPLATES_DIR, "manifest.json");
    const content = await Bun.file(manifestPath).text();
    const registry = JSON.parse(content) as ManifestRegistry;

    for (const template of registry.templates) {
      for (const file of template.files) {
        if (file.kind !== "ejs") {
          continue;
        }
        const absolutePath = resolve(TEMPLATES_DIR, file.src);
        const fileContent = await Bun.file(absolutePath).text();
        const openTags = (fileContent.match(/<%/g) ?? []).length;
        const closeTags = (fileContent.match(/%>/g) ?? []).length;
        expect(
          openTags,
          `Mismatched EJS tags in ${file.src}: ${openTags} open, ${closeTags} close`
        ).toBe(closeTags);
      }
    }
  });
});

describe("static files — no EJS-like tokens", () => {
  it("static files do not contain raw {{TOKEN}} strings", async () => {
    const manifestPath = resolve(TEMPLATES_DIR, "manifest.json");
    const content = await Bun.file(manifestPath).text();
    const registry = JSON.parse(content) as ManifestRegistry;

    for (const template of registry.templates) {
      for (const file of template.files) {
        if (file.kind !== "static") {
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

describe("package.json.ejs files — valid JSON after stripping EJS tags", () => {
  it("simple/package.json.ejs is JSON-parseable after stripping EJS", async () => {
    const src = resolve(TEMPLATES_DIR, "simple/package.json.ejs");
    let raw = await Bun.file(src).text();
    // EJS output tags appear inside JSON string values, e.g. "<%= expr %>"
    // Replace the tag content but keep the surrounding JSON quotes intact
    raw = raw.replace(/<%=\s*[^%]+\s*%>/g, "0.0.0");
    // Remove EJS control tags
    raw = raw.replace(/<%[^=][^%]*%>/g, "");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("full/package.json.ejs is JSON-parseable after stripping EJS", async () => {
    const src = resolve(TEMPLATES_DIR, "full/package.json.ejs");
    let raw = await Bun.file(src).text();
    raw = raw.replace(/<%=\s*[^%]+\s*%>/g, "0.0.0");
    raw = raw.replace(/<%[^=][^%]*%>/g, "");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
