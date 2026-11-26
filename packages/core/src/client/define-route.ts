import type { ErrorComponent } from "../shared/error.ts";
import type { NotFoundComponent } from "../shared/not-found.ts";
import type { RemountDeps } from "../shared/page-key.ts";
import type { PendingComponent, PendingOptions, RoutePending } from "../shared/pending.ts";

type ClientComponent = (props: never) => React.ReactNode;

interface ClientRuntimeProps {
  children?: React.ReactNode;
  params?: unknown;
  path?: unknown;
  query?: unknown;
  [key: string]: unknown;
}

type ClientRuntimeComponent = (props: ClientRuntimeProps) => React.ReactNode;

type LoaderDeps = (query: never) => object;

interface ClientBuilderState {
  errorComponent: ErrorComponent | undefined;
  loaderDeps: LoaderDeps | undefined;
  notFoundComponent: NotFoundComponent | undefined;
  pending: RoutePending | undefined;
  remountDeps: RemountDeps<never, never> | undefined;
}

function createRouteBuilder(state: ClientBuilderState) {
  const { errorComponent, loaderDeps, notFoundComponent, pending, remountDeps } = state;
  return {
    config(options: { loaderDeps?: LoaderDeps; remountDeps?: RemountDeps<never, never> }) {
      return createRouteBuilder({
        ...state,
        loaderDeps: options.loaderDeps,
        remountDeps: options.remountDeps,
      });
    },
    error(component: ErrorComponent) {
      return createRouteBuilder({ ...state, errorComponent: component });
    },
    layout<Component extends ClientComponent>(component: Component) {
      const runtimeComponent = component as unknown as ClientRuntimeComponent;
      return {
        __type: "FURIN_ROUTE" as const,
        component: runtimeComponent,
        errorComponent,
        layout: runtimeComponent,
        notFoundComponent,
        pending,
      };
    },
    notFound(component: NotFoundComponent) {
      return createRouteBuilder({ ...state, notFoundComponent: component });
    },
    pending(component: PendingComponent, options?: PendingOptions) {
      return createRouteBuilder({
        ...state,
        pending: { component, minMs: options?.minMs, ms: options?.ms },
      });
    },
    page<Component extends ClientComponent>(component: Component) {
      const runtimeComponent = component as unknown as ClientRuntimeComponent;
      return {
        __type: "FURIN_ROUTE" as const,
        component: runtimeComponent,
        errorComponent,
        loaderDeps,
        notFoundComponent,
        page: runtimeComponent,
        pending,
        remountDeps,
      };
    },
  };
}

const EMPTY_BUILDER: ClientBuilderState = {
  errorComponent: undefined,
  loaderDeps: undefined,
  notFoundComponent: undefined,
  pending: undefined,
  remountDeps: undefined,
};

/** The file id of `defineRoute(id)` is type-only: the client ignores it. */
export function defineRoute(_id: string) {
  return createRouteBuilder(EMPTY_BUILDER);
}

/** Client stub for the root-layout builder — identical surface. */
export function defineRootRoute() {
  return createRouteBuilder(EMPTY_BUILDER);
}
