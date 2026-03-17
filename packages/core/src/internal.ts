// ── Compile-time context for compiled binaries ──────────────────────────────
// The generated compile entry calls `__setCompileContext()` before importing
// server.ts. At runtime, `router.ts` and `furin.ts` use `getCompileContext()`
// to resolve modules and assets from the binary instead of the filesystem.

export interface EmbeddedAppData {
  assets: Record<string, string>;
  template: string;
}

export interface CompileContextRoute {
  mode: "ssr" | "ssg" | "isr";
  path: string;
  pattern: string;
}

export interface CompileContext {
  buildId: string;
  embedded?: EmbeddedAppData;
  modules: Record<string, unknown>;
  rootPath: string;
  routes: CompileContextRoute[];
}

let _compileCtx: CompileContext | null = null;

export function __setCompileContext(ctx: CompileContext): void {
  _compileCtx = ctx;
}

export function getCompileContext(): CompileContext | null {
  return _compileCtx;
}

export function __resetCompileContext(): void {
  _compileCtx = null;
}
