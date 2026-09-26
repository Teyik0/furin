export function handleDevRequest(): Promise<never> {
  return Promise.reject(new Error("[furin] Development routing is unavailable in production."));
}

export function resolveCurrentDevRoute<Route, Root>(
  route: Route,
  root: Root
): Promise<{ route: Route; root: Root }> {
  return Promise.resolve({ root, route });
}

export function reportDevRouteFailure(): void {
  // Development diagnostics are unavailable in production.
}

export function invalidateStampedRouteModules(): void {
  // Development route modules do not exist in production.
}
