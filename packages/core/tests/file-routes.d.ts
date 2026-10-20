/**
 * Core tests build their routes in memory, not from a pages tree, so no
 * typegen runs: any id names a route of either kind with no parent, as before
 * an app's first typegen. A test whose routes need a parent declares its own
 * uniquely-keyed entries next to them, as furin-env.d.ts would.
 */
import "@teyik0/furin/routes";

declare module "@teyik0/furin/routes" {
  interface FileRoutes {
    [id: string]: {
      kind: "layout" | "page";
      parent: unknown;
      pathParams: NonNullable<unknown>;
    };
  }
}
