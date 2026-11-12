import type { RuntimePage, RuntimeRoute } from "../../client/internal/runtime-types.ts";
import type { HeadOptions, RenderingMode } from "../../client.ts";
import type { ErrorComponent } from "../../shared/error.ts";
import type { NotFoundComponent } from "../../shared/not-found.ts";
import type { RemountDependency } from "../../shared/page-key.ts";

interface DefinedRouteTerminal {
  __type: "FURIN_ROUTE";
  component: (...args: never[]) => React.ReactNode;
  elysia: object;
  errorComponent?: ErrorComponent;
  head?: (...args: never[]) => HeadOptions;
  layout?: (...args: never[]) => React.ReactNode;
  loader?: (...args: never[]) => unknown;
  mode?: RenderingMode;
  notFoundComponent?: NotFoundComponent;
  page?: (...args: never[]) => React.ReactNode;
  remountDeps?: (context: never) => readonly RemountDependency[];
  requestLoader?: (...args: never[]) => unknown;
  revalidate?: number;
  schemas?: { params?: unknown; query?: unknown };
  staticParams?: (context: never) => Promise<readonly unknown[]> | readonly unknown[];
  tags?: readonly string[];
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
  const component = route.component as RuntimeRoute["layout"];
  return {
    __type: "FURIN_ROUTE",
    errorComponent: route.errorComponent,
    layout: component,
    loader: route.loader as RuntimeRoute["loader"],
    mode: route.mode,
    notFoundComponent: route.notFoundComponent,
    params: route.schemas?.params,
    ...(parent ? { parent } : {}),
    query: route.schemas?.query,
    requestLoader: route.requestLoader as RuntimeRoute["requestLoader"],
    revalidate: route.revalidate,
    sourcePath,
    staticParams: route.staticParams as RuntimeRoute["staticParams"],
    tags: copyTags(route.tags),
  };
}

export function adaptDefinedPage(route: DefinedRouteTerminal, parent: RuntimeRoute): RuntimePage {
  const component = route.component as RuntimePage["component"];
  const head = route.head as RuntimePage["head"];
  return {
    __type: "FURIN_PAGE",
    _route: {
      __type: "FURIN_ROUTE",
      params: route.schemas?.params,
      parent,
      query: route.schemas?.query,
      remountDeps: route.remountDeps as RuntimeRoute["remountDeps"],
      requestLoader: route.requestLoader as RuntimeRoute["requestLoader"],
    },
    component,
    errorComponent: route.errorComponent,
    head,
    loader: route.loader as RuntimePage["loader"],
    mode: route.mode,
    notFoundComponent: route.notFoundComponent,
    revalidate: route.revalidate,
    staticParams: route.staticParams as RuntimePage["staticParams"],
    tags: copyTags(route.tags),
  };
}
