import { type AnyElysia, Elysia } from "elysia";

export function createDevDiagnosticPlugin(
  _store: undefined,
  _instance: unknown,
  _reconcileRoutes: unknown
): AnyElysia {
  return new Elysia();
}

export function createDevelopmentBrowserEventSources(
  _instance: unknown,
  _diagnostics: undefined
): readonly never[] {
  return [];
}

export function devDiagnosticStore(): undefined {
  // Development-only state is absent from production bundles.
}

export function injectDevDiagnosticClient(html: string, _basePath: string): string {
  return html;
}
