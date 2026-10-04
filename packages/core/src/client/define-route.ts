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

function createRouteBuilder(remountDeps: RemountDeps<never, never> | undefined) {
  return {
    config(options: { remountDeps?: RemountDeps<never, never> }) {
      return createRouteBuilder(options.remountDeps);
    },
    layout<Component extends ClientComponent>(component: Component) {
      const runtimeComponent = component as unknown as ClientRuntimeComponent;
      return {
        __type: "FURIN_ROUTE" as const,
        component: runtimeComponent,
        layout: runtimeComponent,
      };
    },
    page<Component extends ClientComponent>(component: Component) {
      const runtimeComponent = component as unknown as ClientRuntimeComponent;
      return {
        __type: "FURIN_ROUTE" as const,
        component: runtimeComponent,
        page: runtimeComponent,
        remountDeps,
      };
    },
  };
}

export function defineRoute() {
  return createRouteBuilder(undefined);
}

/** Client stub for the root-layout builder — identical surface. */
export function defineRootRoute() {
  return defineRoute();
}
