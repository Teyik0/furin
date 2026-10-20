/**
 * Typecheck fallback for the virtual `furin/routes` module.
 * The generated furin-env.d.ts augments this interface with one entry per
 * exact route pattern (`"/weather/:city"`); client types resolve concrete
 * paths (`"/weather/paris"`) against those patterns.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentionally augmented by generated route types
export interface RouteMap {}

/**
 * Typecheck fallback for `defineRoute(id)`. The generated
 * furin-env.d.ts augments it with one entry per route file, keyed by its file
 * id (`"/board/[boardId]"`, `"/board/_route"`): kind, URL pattern, parent
 * layout and path params, read from the pages tree without importing modules.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentionally augmented by generated route types
export interface FileRoutes {}

/**
 * Registers the application whose GET routes `invalidate()` may target, re-exported by
 * `@teyik0/furin`: `declare module "@teyik0/furin" { interface Register { app: typeof app } }`.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentionally augmented by applications
export interface Register {}
