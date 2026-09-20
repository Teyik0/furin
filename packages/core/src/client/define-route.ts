type ClientComponent = (props: never) => React.ReactNode;

interface ClientRuntimeProps {
  children?: React.ReactNode;
  params?: unknown;
  path?: unknown;
  query?: unknown;
  requestData?: unknown;
  [key: string]: unknown;
}

type ClientRuntimeComponent = (props: ClientRuntimeProps) => React.ReactNode;

export function defineRoute() {
  return {
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
      };
    },
  };
}

/** Client stub for the root-layout builder — identical surface. */
export function defineRootRoute() {
  return defineRoute();
}
