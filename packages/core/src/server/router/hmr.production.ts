export function handleDevRequest(): Promise<never> {
  return Promise.reject(new Error("[furin] Development routing is unavailable in production."));
}

export function invalidateStampedRouteModules(): void {
  // Development route modules do not exist in production.
}
