import type { ErrorComponent } from "../shared/error.ts";
import type { NotFoundComponent } from "../shared/not-found.ts";
import type { RemountDeps } from "../shared/page-key.ts";

type ClientComponent = (props: never) => React.ReactNode;

interface ClientRuntimeProps {
  children?: React.ReactNode;
  params?: unknown;
  path?: unknown;
  query?: unknown;
  [key: string]: unknown;
}

type ClientRuntimeComponent = (props: ClientRuntimeProps) => React.ReactNode;

interface ClientBuilderState {
  errorComponent: ErrorComponent | undefined;
  notFoundComponent: NotFoundComponent | undefined;
  remountDeps: RemountDeps<never, never> | undefined;
}

function createRouteBuilder(state: ClientBuilderState) {
  const { errorComponent, notFoundComponent, remountDeps } = state;
  return {
    config(options: { remountDeps?: RemountDeps<never, never> }) {
      return createRouteBuilder({ ...state, remountDeps: options.remountDeps });
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
      };
    },
    notFound(component: NotFoundComponent) {
      return createRouteBuilder({ ...state, notFoundComponent: component });
    },
    page<Component extends ClientComponent>(component: Component) {
      const runtimeComponent = component as unknown as ClientRuntimeComponent;
      return {
        __type: "FURIN_ROUTE" as const,
        component: runtimeComponent,
        errorComponent,
        notFoundComponent,
        page: runtimeComponent,
        remountDeps,
      };
    },
  };
}

const EMPTY_BUILDER: ClientBuilderState = {
  errorComponent: undefined,
  notFoundComponent: undefined,
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
