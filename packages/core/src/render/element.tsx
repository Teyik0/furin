import type { ReactNode } from "react";
import type { RuntimeRoute } from "../client";
import type { ErrorComponent } from "../error";
import type { FurinNotFoundError, NotFoundComponent } from "../not-found";
import type { ResolvedRoute } from "../router";

export function buildElement(
  route: ResolvedRoute,
  data: Record<string, unknown>,
  rootLayout: RuntimeRoute
): ReactNode {
  const Component = route.page.component;
  let element: ReactNode = <Component {...data} />;

  for (let i = route.routeChain.length - 1; i >= 1; i--) {
    const routeEntry = route.routeChain[i];

    if (routeEntry?.layout) {
      const Layout = routeEntry.layout;
      element = <Layout {...data}>{element}</Layout>;
    }
  }

  if (rootLayout.layout) {
    const RootLayoutComponent = rootLayout.layout;
    element = <RootLayoutComponent {...data}>{element}</RootLayoutComponent>;
  }

  return element;
}

const DefaultNotFoundComponent: NotFoundComponent = () => (
  <div>
    <h1>404 — Not Found</h1>
  </div>
);

export function buildNotFoundElement(
  component: NotFoundComponent | undefined,
  error: FurinNotFoundError
): ReactNode {
  const NotFound = component ?? DefaultNotFoundComponent;
  return <NotFound error={{ message: error.message, data: error.data }} />;
}

const DefaultErrorComponent: ErrorComponent = ({ error }) => (
  <div>
    <h1>500 — Something went wrong</h1>
    {error.message ? <p>{error.message}</p> : null}
  </div>
);

function errorMessageOf(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "";
}

export function buildErrorElement(
  component: ErrorComponent | undefined,
  error: unknown
): ReactNode {
  const ErrorView = component ?? DefaultErrorComponent;
  return <ErrorView error={{ message: errorMessageOf(error) }} />;
}
