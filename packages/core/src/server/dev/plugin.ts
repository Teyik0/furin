import { type AnyElysia, Elysia } from "elysia";
import type { DevDiagnosticEvent } from "../../shared/dev-diagnostics.ts";
import { browserEventsClientScript } from "../browser-events/plugin.ts";
import type { FurinInstance } from "../instance.ts";
import {
  type ClientErrorReport,
  type DevDiagnosticStore,
  publishClientDiagnostic,
} from "./diagnostics.ts";
import { forbiddenDevelopmentRequest } from "./request-security.ts";

interface EmbeddedDiagnosticState {
  basePath: string;
  event: Extract<DevDiagnosticEvent, { type: "error" }>;
}

let overlayClientSource: string | undefined;

async function clientSource(): Promise<string> {
  if (overlayClientSource !== undefined) {
    return overlayClientSource;
  }
  const candidates = [
    new URL("../../client/dev-error-overlay.ts", import.meta.url),
    new URL("./client/dev-error-overlay.ts", import.meta.url),
  ];
  const sources = await Promise.all(
    candidates.map(async (path) => {
      const file = Bun.file(path);
      return (await file.exists()) ? await file.text() : undefined;
    })
  );
  const source = sources.find((candidate) => candidate !== undefined);
  if (source !== undefined) {
    overlayClientSource = new Bun.Transpiler({ loader: "ts" }).transformSync(source, "ts");
    return overlayClientSource;
  }
  throw new Error("Furin development overlay source is missing from the package.");
}

function clientErrorReport(value: unknown): ClientErrorReport | undefined {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const candidate = value as {
    cause?: unknown;
    message?: unknown;
    phase?: unknown;
    route?: unknown;
    stack?: unknown;
  };
  if (
    typeof candidate.message !== "string" ||
    (candidate.phase !== "client-render" && candidate.phase !== "hydrate") ||
    typeof candidate.route !== "string"
  ) {
    return;
  }
  return {
    cause: typeof candidate.cause === "string" ? candidate.cause : undefined,
    message: candidate.message,
    phase: candidate.phase,
    route: candidate.route,
    stack: typeof candidate.stack === "string" ? candidate.stack : undefined,
  };
}

function serializeForHtml(value: EmbeddedDiagnosticState): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function createDevDiagnosticPlugin(
  store: DevDiagnosticStore,
  instance: FurinInstance | undefined
): AnyElysia {
  return new Elysia({ name: "furin-dev-diagnostics" })
    .get("/_furin/dev/overlay.js", async ({ request, server }) => {
      const forbidden = forbiddenDevelopmentRequest(request, server);
      if (forbidden) {
        return forbidden;
      }
      return new Response(await clientSource(), {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/javascript; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    })
    .post("/_furin/dev/client-errors", async ({ body, request, server }) => {
      const forbidden = forbiddenDevelopmentRequest(request, server);
      if (forbidden) {
        return forbidden;
      }
      const report = clientErrorReport(body);
      if (!report) {
        return new Response("Invalid client diagnostic", { status: 400 });
      }
      return await publishClientDiagnostic(store, report, new URL(request.url).origin, instance);
    });
}

export function injectDevDiagnosticClient(html: string, basePath: string): string {
  const script = `<script data-furin-framework-module="" type="module" src="${basePath}/_furin/dev/overlay.js"></script>`;
  if (html.includes(script)) {
    return html;
  }
  return html.includes("</head>")
    ? html.replace("</head>", `${script}</head>`)
    : `${script}${html}`;
}

export function renderDevDiagnosticResponse(
  event: Extract<DevDiagnosticEvent, { type: "error" }>,
  basePath: string
): Response {
  const state = serializeForHtml({ basePath, event });
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Furin development error</title>${browserEventsClientScript(basePath)}</head><body><script id="__FURIN_DEV_DIAGNOSTIC__" type="application/json">${state}</script><script type="module" src="${basePath}/_furin/dev/overlay.js"></script></body></html>`,
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
      status: 500,
    }
  );
}
