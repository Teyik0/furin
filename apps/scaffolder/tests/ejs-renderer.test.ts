import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { renderEjsFile } from "../src/engine/renderer";
import type { EjsTemplateVars } from "../src/pipeline/context";

const TEMPLATES_DIR = resolve(import.meta.dir, "../templates");

const mockVars: EjsTemplateVars = {
  features: ["tailwind"],
  furinVersion: "0.1.0-alpha.4",
  projectName: "My Test App",
  projectNameKebab: "my-test-app",
  projectNamePascal: "MyTestApp",
  versions: {
    "@teyik0/furin": "0.1.0-alpha.4",
    "@types/bun": "latest",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "bun-plugin-tailwind": "^0.0.16",
    elysia: "^1.4.28",
    evlog: "^2.10.0",
    react: "^19.1.0",
    "react-dom": "^19.1.0",
    tailwindcss: "^4.1.3",
    typescript: "^5.8.3",
  },
};

describe("renderEjsFile — simple template", () => {
  it("renders server.ts.ejs with projectName substituted", async () => {
    const src = resolve(TEMPLATES_DIR, "simple/src/server.ts.ejs");
    const output = await renderEjsFile(src, mockVars);
    expect(output).toContain(JSON.stringify(mockVars.projectName));
    expect(output).not.toContain("<%=");
  });

  it("preserves special characters in projectName as generated JavaScript data", async () => {
    const src = resolve(TEMPLATES_DIR, "simple/src/server.ts.ejs");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: security regression sentinel must remain literal.
    const projectName = "A&B <app> `${globalThis.compromised = true}`";
    const output = await renderEjsFile(src, { ...mockVars, projectName });
    const statement = output
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("console.log("));
    if (statement === undefined) {
      throw new Error("Expected the generated server to log its URL");
    }
    const messages: string[] = [];

    Function(
      "app",
      "console",
      statement
    )({ server: { port: 3000 } }, { log: (message: string) => messages.push(message) });

    expect(messages).toEqual([`${projectName} running at http://localhost:3000`]);
    expect(globalThis).not.toHaveProperty("compromised");
  });

  it("renders furin-env.d.ts.ejs without leftover EJS tags", async () => {
    const src = resolve(TEMPLATES_DIR, "simple/furin-env.d.ts.ejs");
    const output = await renderEjsFile(src, mockVars);
    expect(output).not.toContain("<%");
    expect(output).toContain("interface RouteMap {");
  });
});

describe("renderEjsFile — full template", () => {
  it("renders server.ts.ejs with projectName substituted", async () => {
    const src = resolve(TEMPLATES_DIR, "full/src/server.ts.ejs");
    const output = await renderEjsFile(src, mockVars);
    expect(output).toContain("Furin running at");
    expect(output).not.toContain("<%=");
  });

  it("does not interpolate a project name as generated JavaScript", async () => {
    const src = resolve(TEMPLATES_DIR, "full/src/server.ts.ejs");
    const output = await renderEjsFile(src, {
      ...mockVars,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: security regression sentinel must remain literal.
      projectName: "${globalThis.compromised = true}",
    });

    expect(output).not.toContain("compromised");
  });
});
