import { isProductionBuild } from "../shared/production-build.ts";

export type RscRenderOperation = "createCompositeComponent" | "renderServerComponent";

interface FurinRscRenderErrorOptions {
  cause: unknown;
  component: string | undefined;
  hook: string | undefined;
  operation: RscRenderOperation;
}

const INTERNAL_STACK_FRAMES = new Set([
  "<anonymous>",
  "performWork",
  "react_stack_bottom_frame",
  "renderFunctionComponent",
  "renderModelDestructive",
  "resolveDispatcher",
  "retryTask",
]);
const DISPATCHER_HOOK_RE = /\b(?:dispatcher|resolveDispatcher\(\))\.(use[A-Z][A-Za-z0-9]*)\b/;
const NULLISH_HOOK_RE = /\b(?:null|undefined).+?['"](use[A-Z][A-Za-z0-9]*)['"]/;
const STACK_FRAME_RE = /^\s*at\s+(?:async\s+)?([^\s(]+)/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

function detectHook(error: unknown): string | undefined {
  const message = errorMessage(error);
  return message.match(DISPATCHER_HOOK_RE)?.[1] ?? message.match(NULLISH_HOOK_RE)?.[1];
}

function detectComponent(error: unknown, hook: string | undefined): string | undefined {
  const stack = errorStack(error);
  if (stack === undefined) {
    return;
  }
  for (const line of stack.split("\n").slice(1)) {
    const name = line.match(STACK_FRAME_RE)?.[1];
    if (
      name !== undefined &&
      name !== hook &&
      (hook === undefined || !name.endsWith(`.${hook}`)) &&
      !name.startsWith("Object.") &&
      !INTERNAL_STACK_FRAMES.has(name)
    ) {
      return name;
    }
  }
}

function renderErrorMessage(options: FurinRscRenderErrorOptions): string {
  if (isProductionBuild()) {
    return `[furin/rsc] Server Component rendering failed inside ${options.operation}().`;
  }
  if (options.hook !== undefined && options.component !== undefined) {
    const diagnostic = `[furin/rsc] A component rendered inside ${options.operation}()
used a client-only React hook.

Component: ${options.component}
Hook: ${options.hook}`;
    if (options.operation === "createCompositeComponent") {
      return `${diagnostic}

Move this component behind a CompositeComponent slot:
createCompositeComponent(({ Icon }) => <Icon />)`;
    }
    return `${diagnostic}

Render this component from a client component instead.`;
  }
  return `[furin/rsc] Server Component rendering failed inside ${options.operation}().

${errorMessage(options.cause)}`;
}

export class FurinRscRenderError extends Error {
  readonly code = "FURIN_RSC_RENDER_ERROR";
  readonly component: string | undefined;
  readonly hook: string | undefined;
  readonly operation: RscRenderOperation;

  constructor(options: FurinRscRenderErrorOptions) {
    super(renderErrorMessage(options), { cause: options.cause });
    this.name = "FurinRscRenderError";
    this.component = options.component;
    this.hook = options.hook;
    this.operation = options.operation;

    const causeStack = errorStack(options.cause);
    if (causeStack !== undefined) {
      this.stack = `${this.name}: ${this.message}\nCaused by: ${causeStack}`;
    }
  }
}

export function isFurinRscRenderError(error: unknown): error is FurinRscRenderError {
  return (
    error instanceof FurinRscRenderError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "FURIN_RSC_RENDER_ERROR")
  );
}

export function createFurinRscRenderError(
  cause: unknown,
  operation: RscRenderOperation
): FurinRscRenderError {
  const hook = detectHook(cause);
  return new FurinRscRenderError({
    cause,
    component: detectComponent(cause, hook),
    hook,
    operation,
  });
}
