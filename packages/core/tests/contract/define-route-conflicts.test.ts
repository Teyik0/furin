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

const createParentRoute = () =>
  defineRootRoute()
    .config({ mode: "ssr" })
    .loader(() => ({ user: "teyik", visits: 2 }))
    .layout(({ children }) => children);

const createCompatibleChild = () =>
  defineRoute()
    .config({ layout: createParentRoute(), mode: "ssr" })
    .loader(() => ({ visits: 3 }))
    .page(({ data }) => {
      expectTypeOf(data.visits).toEqualTypeOf<number>();
      expectTypeOf(data.user).toEqualTypeOf<string>();
      return `${data.user}:${data.visits}`;
    });

const createConflictingChild = () =>
  defineRoute()
    .config({ layout: createParentRoute(), mode: "ssr" })
    .loader(() => ({ user: 42 }))
    .page(({ data }) => {
      // @ts-expect-error — `user` is the branded conflict marker: the child
      // loader's `number` overwrites the parent's `string`.
      const user: string = data.user;
      return String(user);
    });

const createConflictingHeadAndLayout = () =>
  defineRoute()
    .config({ layout: createParentRoute(), mode: "ssr" })
    .loader(() => ({ visits: "many" }))
    .head(({ data }) => {
      // @ts-expect-error — `visits` conflicts: number (parent) vs string.
      const visits: number = data.visits;
      return { meta: [{ title: String(visits) }] };
    })
    .layout(({ children, data }) => {
      // @ts-expect-error — same branded conflict, layout reads included.
      const _conflict: number = data.visits;
      return children;
    });

const createParentlessRoute = () =>
  defineRootRoute()
    .config({ mode: "ssr" })
    .loader(() => ({ user: 42 }))
    .page(({ data }) => {
      expectTypeOf(data.user).toEqualTypeOf<number>();
      return String(data.user);
    });

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
});
