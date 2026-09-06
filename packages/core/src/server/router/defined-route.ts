import type {
  RuntimeData,
  RuntimePage,
  RuntimeRoute,
} from "../../client/internal/runtime-types.ts";
import type { HeadOptions, RenderingMode } from "../../client.ts";

interface DefinedRouteTerminal {
  __type: "FURIN_ROUTE";
  component: (...args: never[]) => React.ReactNode;
  elysia: object;
  head?: (...args: never[]) => HeadOptions;
  layout?: (...args: never[]) => React.ReactNode;
  loader?: (...args: never[]) => unknown;
  mode?: RenderingMode;
  page?: (...args: never[]) => React.ReactNode;
  requestLoader?: (...args: never[]) => unknown;
  revalidate?: number;
  schemas?: { params?: unknown; query?: unknown };
  staticParams?: () => Promise<readonly unknown[]> | readonly unknown[];
  tags?: readonly string[];
}

interface DefinedRenderContext {
  children?: React.ReactNode;
  data: RuntimeData;
  params: unknown;
  path: string;
  query: unknown;
  requestData?: Promise<object>;
}

function toDefinedRenderContext(props: RuntimeData): DefinedRenderContext {
  const {
    children,
    params = {},
    path: _path,
    query = {},
    requestData,
    ...data
  } = props as RuntimeData & { children?: React.ReactNode };
  return {
    children,
    data,
    params,
    path: (_path as string | undefined) ?? "",
    query,
    requestData: requestData as Promise<object> | undefined,
  };
}

function copyTags(tags: readonly string[] | undefined): string[] | undefined {
  return tags ? [...tags] : undefined;
}

export function isDefinedRouteTerminal(value: unknown): value is DefinedRouteTerminal {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<DefinedRouteTerminal>;
  return (
    candidate.__type === "FURIN_ROUTE" &&
    typeof candidate.component === "function" &&
    typeof candidate.elysia === "object" &&
    candidate.elysia !== null
  );
}

export function adaptDefinedLayout(
  route: DefinedRouteTerminal,
  parent: RuntimeRoute | undefined,
  sourcePath?: string
): RuntimeRoute {
  const component = route.component as (props: DefinedRenderContext) => React.ReactNode;
  return {
    __type: "FURIN_ROUTE",
    layout: (props) => component(toDefinedRenderContext(props)),
    loader: route.loader as RuntimeRoute["loader"],
    mode: route.mode,
    params: route.schemas?.params,
    ...(parent ? { parent } : {}),
    query: route.schemas?.query,
    requestLoader: route.requestLoader as RuntimeRoute["requestLoader"],
    revalidate: route.revalidate,
    sourcePath,
    tags: copyTags(route.tags),
  };
}

export function adaptDefinedPage(route: DefinedRouteTerminal, parent: RuntimeRoute): RuntimePage {
  const component = route.component as (props: DefinedRenderContext) => React.ReactNode;
  const head = route.head as ((context: DefinedRenderContext) => HeadOptions) | undefined;
  return {
    __type: "FURIN_PAGE",
    _route: {
      __type: "FURIN_ROUTE",
      params: route.schemas?.params,
      parent,
      query: route.schemas?.query,
      requestLoader: route.requestLoader as RuntimeRoute["requestLoader"],
    },
    component: (props) => component(toDefinedRenderContext(props)),
    head: head ? (props) => head(toDefinedRenderContext(props)) : undefined,
    loader: route.loader as RuntimePage["loader"],
    mode: route.mode,
    revalidate: route.revalidate,
    staticParams: route.staticParams as RuntimePage["staticParams"],
    tags: copyTags(route.tags),
  };
}
