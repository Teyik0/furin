import type { RuntimeRoute } from "../client";
import { IS_DEV } from "../elyra";
import type { ResolvedRoute, RootLayout } from "../router";

/**
 * Loads the page module for a given route.
 * In dev mode, re-imports on every request so Bun's module registry
 * (invalidated by --hot) always returns the current version.
 *
 * Coverage note: error-recovery paths require Bun's module system to fail,
 * which is not possible in unit tests — covered by integration tests only.
 */
export async function loadPageModule(route: ResolvedRoute) {
  if (!IS_DEV && route.page) {
    return route.page;
  }

  if (IS_DEV) {
    try {
      const mod = await import(route.pagePath);
      route.page = mod.default;
      return route.page;
    } catch (error) {
      if (!route.page) {
        throw error;
      }
      console.error(`[elyra] Failed to load page ${route.pagePath}:`, error);
      return route.page;
    }
  }

  return route.page;
}

/**
 * Loads the root layout module.
 * In dev mode, always re-imports to pick up HMR changes.
 */
export async function loadRootModule(root: RootLayout): Promise<RuntimeRoute> {
  if (!IS_DEV) {
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
    console.error(`[elyra] Failed to load root layout ${root.path}:`, error);
    return root.route;
  }
}
