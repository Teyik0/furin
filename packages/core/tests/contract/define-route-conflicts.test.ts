// biome-ignore-all lint/suspicious/noUnusedExpressions: type-level assertions are compile-time only

import { describe, expectTypeOf, test } from "bun:test";

/**
 * Type-level contract: a child loader key that shadows a parent loader key
 * with an INCOMPATIBLE type surfaces a readable branded error when the
 * conflicted field is read — same-name-same-type overrides stay legitimate.
 *
 * Type-only file: `defineRoute` is a `declare const` so `furin.ts` is never
 * loaded at runtime (Bun 1.4 hangs on otherwise-static contract tests — see
 * elysia-route-manifest-types.type.test.ts). Assertions run via `bun run tscheck`;
 * the `@ts-expect-error` directives below must stay consumed.
 */

declare const defineRoute: typeof import("../../src/furin.ts").defineRoute;
declare const defineRootRoute: typeof import("../../src/furin.ts").defineRootRoute;
declare const t: typeof import("elysia").t;

const createParentRoute = () =>
  defineRootRoute()
    .config({ mode: "ssr" })
    .loader(() => ({ user: "teyik", visits: 2 }))
    .layout(({ children }) => children);

const createCompatibleChild = () =>
  defineRoute()
    .config({ layout: createParentRoute(), mode: "ssr" })
    .loader(() => ({ visits: 3 }))
    .page(({ user, visits }) => {
      expectTypeOf(visits).toEqualTypeOf<number>();
      expectTypeOf(user).toEqualTypeOf<string>();
      return `${user}:${visits}`;
    });

const createConflictingChild = () =>
  defineRoute()
    .config({ layout: createParentRoute(), mode: "ssr" })
    .loader(() => ({ user: 42 }))
    .page(({ user: conflictedUser }) => {
      // @ts-expect-error — `user` is the branded conflict marker: the child
      // loader's `number` overwrites the parent's `string`.
      const user: string = conflictedUser;
      return String(user);
    });

const createConflictingHeadAndLayout = () =>
  defineRoute()
    .config({ layout: createParentRoute(), mode: "ssr" })
    .loader(() => ({ visits: "many" }))
    .head(({ visits }) => {
      // @ts-expect-error — `visits` conflicts: number (parent) vs string.
      const count: number = visits;
      return { meta: [{ title: String(count) }] };
    })
    .layout(({ children, visits }) => {
      // @ts-expect-error — same branded conflict, layout reads included.
      const _conflict: number = visits;
      return children;
    });

const createParentlessRoute = () =>
  defineRootRoute()
    .config({ mode: "ssr" })
    .loader(() => ({ user: 42 }))
    .page(({ user }) => {
      expectTypeOf(user).toEqualTypeOf<number>();
      return String(user);
    });

const createRoutesWithReservedLoaderKeys = () => {
  const noSchema = defineRootRoute()
    .config({ mode: "ssr" })
    // @ts-expect-error — public loader fields cannot shadow route params.
    .loader(() => ({ params: "shadowed" }));
  const querySchema = defineRootRoute()
    .config({ mode: "ssr", query: t.Object({ page: t.Number() }) })
    // @ts-expect-error — public loader fields cannot shadow React children.
    .loader(() => ({ children: "shadowed" }));
  const paramsSchema = defineRootRoute()
    .config({ mode: "ssr", params: t.Object({ id: t.String() }) })
    // @ts-expect-error — public loader fields cannot use React's key prop.
    .loader(() => ({ key: "shadowed" }));
  const internalNamespace = defineRootRoute()
    .config({ mode: "ssr" })
    // @ts-expect-error — public loader fields cannot use Furin's internal namespace.
    .loader(() => ({ __furinHead: "shadowed" }));
  const path = defineRootRoute()
    .config({ mode: "ssr" })
    // @ts-expect-error — public loader fields cannot shadow the route path.
    .loader(() => ({ path: "shadowed" }));
  const query = defineRootRoute()
    .config({ mode: "ssr" })
    // @ts-expect-error — public loader fields cannot shadow validated query values.
    .loader(() => ({ query: "shadowed" }));
  const ref = defineRootRoute()
    .config({ mode: "ssr" })
    // @ts-expect-error — public loader fields cannot use React's ref prop.
    .loader(() => ({ ref: "shadowed" }));
  const requestData = defineRootRoute()
    .config({ mode: "ssr" })
    // @ts-expect-error — public loader fields cannot shadow private request data.
    .loader(() => ({ requestData: "shadowed" }));
  const then = defineRootRoute()
    .config({ mode: "ssr" })
    // @ts-expect-error — thenable protocol keys are reserved by staticParams contexts.
    // biome-ignore lint/suspicious/noThenProperty: verifies that this dangerous key is rejected.
    .loader(() => ({ then: "shadowed" }));
  return {
    internalNamespace,
    noSchema,
    paramsSchema,
    path,
    query,
    querySchema,
    ref,
    requestData,
    then,
  };
};

describe("defineRoute parentData conflicts", () => {
  test("compatible override keeps the parent-friendly type", () => {
    expectTypeOf<ReturnType<typeof createCompatibleChild>>().not.toBeNever();
  });

  test("incompatible override surfaces a readable conflict on read", () => {
    expectTypeOf<ReturnType<typeof createConflictingChild>>().not.toBeNever();
  });

  test("conflict propagates to head and layout reads too", () => {
    expectTypeOf<ReturnType<typeof createConflictingHeadAndLayout>>().not.toBeNever();
  });

  test("no parent means no conflict surface", () => {
    expectTypeOf<ReturnType<typeof createParentlessRoute>>().not.toBeNever();
  });

  test("reserved render-context keys are rejected by every loader chain", () => {
    expectTypeOf<ReturnType<typeof createRoutesWithReservedLoaderKeys>>().not.toBeNever();
  });
});
