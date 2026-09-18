import type { PostponedState } from "react-dom/static";

export interface PprResumeState {
  buildId: string;
  data: string;
  headers: { [name: string]: string };
  path: string;
  postponed: PostponedState | null;
  prefix: string;
  version: 1;
}

export function isPprResumeState(value: unknown): value is PprResumeState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const state = value as {
    buildId?: unknown;
    data?: unknown;
    headers?: unknown;
    path?: unknown;
    postponed?: unknown;
    prefix?: unknown;
    version?: unknown;
  };
  return (
    state.version === 1 &&
    typeof state.buildId === "string" &&
    typeof state.prefix === "string" &&
    typeof state.path === "string" &&
    state.path.startsWith("/") &&
    !state.path.startsWith("//") &&
    typeof state.data === "string" &&
    state.headers !== null &&
    typeof state.headers === "object" &&
    !Array.isArray(state.headers) &&
    Object.values(state.headers).every((header) => typeof header === "string") &&
    (state.postponed === null ||
      (typeof state.postponed === "object" && !Array.isArray(state.postponed)))
  );
}

const resumeRequests = new WeakMap<Request, PprResumeState>();

export function getPprResumeState(request: Request): PprResumeState | undefined {
  return resumeRequests.get(request);
}

export function markPprResumeRequest(request: Request, state: PprResumeState): Request {
  resumeRequests.set(request, state);
  return request;
}

/** Called only after the deployment adapter authenticates its private chain header. */
export async function restorePprResumeRequest(
  request: Request,
  builds: { buildId: string; prefix: string; patterns: RegExp[] }[]
): Promise<Request | Response> {
  let state: PprResumeState;
  try {
    const value: unknown = JSON.parse(await request.text());
    if (!isPprResumeState(value)) {
      throw new Error("Invalid resume state");
    }
    state = value;
  } catch {
    return new Response("Invalid PPR resume state", { status: 400 });
  }
  const build = builds.find(
    (candidate) => candidate.prefix === state.prefix && candidate.buildId === state.buildId
  );
  const url = new URL(request.url);
  const restored = new URL(state.path, url.origin);
  if (
    !build ||
    restored.origin !== url.origin ||
    !build.patterns.some((pattern) => pattern.test(restored.pathname))
  ) {
    return new Response("PPR build or route mismatch", { status: 409 });
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("content-type");
  headers.delete("x-furin-ppr-resume");
  return markPprResumeRequest(
    new Request(restored, { headers, method: "GET", signal: request.signal }),
    state
  );
}

export function pprContentType(state: string): string {
  return `application/x-nextjs-pre-render; state-length=${new TextEncoder().encode(state).byteLength}; origin="text/html; charset=utf-8"`;
}

export function pprPrerenderResponse(artifact: { html: string; state: PprResumeState }): Response {
  const state = JSON.stringify(artifact.state);
  return new Response(state + artifact.html, {
    headers: {
      "cache-control": "private, no-store",
      "cache-tag": new URL(artifact.state.path, "http://furin.local").pathname,
      "content-type": pprContentType(state),
    },
  });
}
