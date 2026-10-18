/**
 * Typecheck fallback for the virtual `furin/routes` module.
 * The generated furin-env.d.ts augments this interface with one entry per
 * exact route pattern (`"/weather/:city"`); client types resolve concrete
 * paths (`"/weather/paris"`) against those patterns.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentionally augmented by generated route types
export interface RouteMap {}

/** Application contract for sync IDs and their resource scopes. */
// biome-ignore lint/suspicious/noEmptyInterface: intentionally augmented by applications
export interface SyncQueryMap {}
