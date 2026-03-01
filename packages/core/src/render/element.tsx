import type { ReactNode } from "react";
import type { RuntimeRoute } from "../client";
import type { ResolvedRoute } from "../router";

export function buildElement(
  route: ResolvedRoute,
  data: Record<string, unknown>,
  rootLayout: RuntimeRoute | null
): ReactNode {
  const page = route.page;
  if (!page) {
    return <div>Loading...</div>;
  }

  const Component = page.component;
  let element: ReactNode = <Component {...data} />;

  for (let i = route.routeChain.length - 1; i >= 1; i--) {
    const routeEntry = route.routeChain[i];

    if (routeEntry?.layout) {
      const Layout = routeEntry.layout;
      element = <Layout {...data}>{element}</Layout>;
    }
  }

  if (rootLayout?.layout) {
    const RootLayoutComponent = rootLayout.layout;
    element = <RootLayoutComponent {...data}>{element}</RootLayoutComponent>;
  }

  return element;
}
