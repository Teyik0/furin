import type { ReactNode } from "react";
import type { RuntimeRoute } from "../client";
import type { ResolvedRoute, RootLayout } from "../router";

export async function loadPageModule(route: ResolvedRoute, dev: boolean) {
  if (!dev && route.page) {
    return route.page;
  }

  if (dev) {
    // In bun --hot mode Bun invalidates its module registry when watched files
    // change, so a plain import() always returns the current version.
    try {
      const mod = await import(route.pagePath);
      route.page = mod.default;
      return route.page;
    } catch (error) {
      if (!route.page) {
        throw error;
      }
      console.error(`[elysion] Failed to load page ${route.pagePath}:`, error);
      return route.page;
    }
  }

  return route.page;
}

export async function loadRootModule(root: RootLayout, dev: boolean): Promise<RuntimeRoute> {
  if (!dev) {
    return root.route;
  }

  try {
    const mod = await import(root.path);
    const rootRoute = mod.route ?? mod.default;
    if (rootRoute?.__type === "ELYSION_ROUTE") {
      return rootRoute;
    }
    return root.route;
  } catch (error) {
    console.error(`[elysion] Failed to load root layout ${root.path}:`, error);
    return root.route;
  }
}

export function buildElement(
  route: ResolvedRoute,
  data: Record<string, unknown>,
  rootLayout: RuntimeRoute | null
): ReactNode {
  const page = route.page;
  if (!page) {
    return <div>Loading; ...</div>;
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
