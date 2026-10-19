import { relative } from "node:path";
import type { DevErrorPayload, DevErrorPhase, DevGraph, DevGraphEvent } from "./graph.ts";
import { stackSourceLocation } from "./stack-location.ts";

interface DevErrorContext {
  entryPath: string;
  importChain: string[];
  phase: DevErrorPhase;
  route: string;
}

interface PublishDevErrorContext {
  entryPath: string;
  phase: DevErrorPhase;
  route: string;
}

interface SourcePosition {
  column: number;
  file: string;
  line: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function errorCause(error: unknown): string | null {
  if (!(error instanceof Error) || error.cause === undefined) {
    return null;
  }
  return errorMessage(error.cause);
}

function buildPosition(error: unknown, entryPath: string): SourcePosition | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const { furinPosition, position } = error as {
    furinPosition?: { column?: unknown; file?: unknown; line?: unknown };
    position?: { column?: unknown; file?: unknown; line?: unknown };
  };
  if (
    furinPosition &&
    typeof furinPosition.file === "string" &&
    typeof furinPosition.line === "number" &&
    typeof furinPosition.column === "number"
  ) {
    return {
      column: furinPosition.column,
      file: furinPosition.file,
      line: furinPosition.line,
    };
  }
  if (!position || typeof position.line !== "number" || typeof position.column !== "number") {
    return null;
  }
  const reportedFile = typeof position.file === "string" ? position.file : entryPath;
  return {
    column: position.column,
    file: reportedFile === "input.tsx" || reportedFile === "input.ts" ? entryPath : reportedFile,
    line: position.line,
  };
}

export function createDevErrorPayload(error: unknown, context: DevErrorContext): DevErrorPayload {
  const stack = error instanceof Error ? (error.stack ?? null) : null;
  const position =
    buildPosition(error, context.entryPath) ??
    stackSourceLocation(stack ?? undefined, context.entryPath);
  return {
    cause: errorCause(error),
    column: position?.column ?? null,
    file: position?.file ?? context.entryPath,
    importChain: context.importChain,
    line: position?.line ?? null,
    message: errorMessage(error),
    phase: context.phase,
    route: context.route,
    stack,
  };
}

function displaySourcePath(path: string): string {
  const projected = relative(process.cwd(), path).replaceAll("\\", "/");
  return projected.startsWith("../") ? path : projected;
}

export function publishDevError<Snapshot>(
  graph: DevGraph<Snapshot>,
  error: unknown,
  context: PublishDevErrorContext
): Extract<DevGraphEvent, { type: "error" }> {
  const payload = createDevErrorPayload(error, {
    ...context,
    importChain: [context.entryPath],
  });
  const sourceError =
    context.phase === "import" || context.phase === "transform"
      ? (graph.diagnoseTransformError(context.entryPath, payload.message) ??
        graph.sourceError(payload.message, context.entryPath))
      : undefined;
  if (sourceError) {
    payload.column = sourceError.column;
    payload.file = sourceError.file;
    payload.line = sourceError.line;
    payload.phase = "transform";
  }
  const sourceFile = payload.file ?? context.entryPath;
  payload.file = displaySourcePath(sourceFile);
  payload.importChain = graph
    .importChain(context.entryPath, sourceFile)
    .map((path) => displaySourcePath(path));
  return graph.publishError(payload);
}
