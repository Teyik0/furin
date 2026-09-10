import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import type { DevSourceLocation, DevStackFrame } from "../../shared/dev-diagnostics.ts";

interface GeneratedFrame {
  functionName: string | undefined;
  location: DevSourceLocation;
}

interface SymbolicateStackInput {
  origin: string;
  stack: string | undefined;
}

interface SymbolicatedStack {
  frames: readonly DevStackFrame[];
  location: DevSourceLocation | undefined;
}

const STACK_FRAME_RE =
  /^\s*at\s+(?:(.*?)\s+\()?((?:https?:\/\/|file:\/\/|bun:\/\/).+):(\d+):(\d+)\)?$/;
const SOURCE_MAP_RE = /\/\/[#@]\s*sourceMappingURL=([^\s]+)/;
const sourceMaps = new Map<string, Promise<TraceMap | undefined>>();

function parseGeneratedFrames(stack: string | undefined): readonly GeneratedFrame[] {
  if (!stack) {
    return [];
  }
  const frames: GeneratedFrame[] = [];
  for (const line of stack.split("\n")) {
    const match = STACK_FRAME_RE.exec(line);
    if (!(match?.[2] && match[3] && match[4])) {
      continue;
    }
    frames.push({
      functionName: match[1] || undefined,
      location: {
        column: Number.parseInt(match[4], 10),
        file: match[2],
        line: Number.parseInt(match[3], 10),
      },
    });
  }
  return frames;
}

function isInternalSource(file: string): boolean {
  return (
    file.startsWith("bun://") ||
    file.includes("/node_modules/") ||
    file.includes("/packages/core/src/") ||
    file.includes("/_bun/")
  );
}

async function loadSourceMap(url: URL, origin: string): Promise<TraceMap | undefined> {
  if (url.pathname.endsWith(".map")) {
    const response = await fetch(url);
    return response.ok ? new TraceMap(await response.json()) : undefined;
  }
  const generatedResponse = await fetch(url);
  const generated = generatedResponse.ok ? await generatedResponse.text() : "";
  const sourceMapReference = SOURCE_MAP_RE.exec(generated)?.[1];
  if (!sourceMapReference) {
    return;
  }
  const sourceMapUrl = new URL(sourceMapReference, url);
  if (sourceMapUrl.origin !== origin) {
    return;
  }
  const sourceMapResponse = await fetch(sourceMapUrl);
  return sourceMapResponse.ok ? new TraceMap(await sourceMapResponse.json()) : undefined;
}

function sourceMapFor(generatedUrl: string, origin: string): Promise<TraceMap | undefined> {
  const url = new URL(generatedUrl);
  if (url.origin !== origin || !url.pathname.includes("/_bun/")) {
    return Promise.resolve(undefined);
  }
  const registered = sourceMaps.get(url.href);
  if (registered) {
    return registered;
  }
  const pending = loadSourceMap(url, origin).catch(() => undefined);
  sourceMaps.set(url.href, pending);
  return pending;
}

async function symbolicateFrame(frame: GeneratedFrame, origin: string): Promise<DevStackFrame> {
  let original: DevSourceLocation | undefined;
  if (frame.location.file.startsWith("http://") || frame.location.file.startsWith("https://")) {
    const map = await sourceMapFor(frame.location.file, origin);
    if (map) {
      const mapped = originalPositionFor(map, {
        column: Math.max(0, frame.location.column - 1),
        line: frame.location.line,
      });
      if (mapped.source && mapped.line !== null && mapped.column !== null) {
        original = {
          column: mapped.column + 1,
          file: mapped.source,
          line: mapped.line,
        };
      }
    }
  }
  const sourceFile = original?.file ?? frame.location.file;
  return {
    functionName: frame.functionName,
    generated: frame.location,
    internal: isInternalSource(sourceFile),
    original,
  };
}

export async function symbolicateStack(input: SymbolicateStackInput): Promise<SymbolicatedStack> {
  const frames = await Promise.all(
    parseGeneratedFrames(input.stack).map((frame) => symbolicateFrame(frame, input.origin))
  );
  const applicationFrame = frames.find((frame) => !frame.internal);
  return {
    frames,
    location: applicationFrame?.original ?? applicationFrame?.generated,
  };
}
