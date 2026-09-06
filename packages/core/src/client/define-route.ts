type ClientComponent = (props: never) => React.ReactNode;

interface ClientRuntimeProps {
  children?: React.ReactNode;
  params?: unknown;
  path?: unknown;
  query?: unknown;
  requestData?: unknown;
  [key: string]: unknown;
}

function toRenderContext(props: ClientRuntimeProps) {
  const { children, params = {}, path = "", query = {}, requestData, ...data } = props;
  return { children, data, params, path, query, requestData };
}

function render<Component extends ClientComponent>(
  component: Component,
  props: ClientRuntimeProps
) {
  return component(toRenderContext(props) as never);
}

export function defineRoute() {
  return {
    layout<Component extends ClientComponent>(component: Component) {
      const clientComponent = (props: ClientRuntimeProps) => render(component, props);
      return {
        __type: "FURIN_ROUTE" as const,
        component: clientComponent,
        layout: clientComponent,
      };
    },
    page<Component extends ClientComponent>(component: Component) {
      const clientComponent = (props: ClientRuntimeProps) => render(component, props);
      return {
        __type: "FURIN_ROUTE" as const,
        component: clientComponent,
        page: clientComponent,
      };
    },
  };
}

/** Client stub for the root-layout builder — identical surface. */
export function defineRootRoute() {
  return defineRoute();
}
