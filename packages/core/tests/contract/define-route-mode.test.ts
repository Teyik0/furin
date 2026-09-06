// biome-ignore-all lint/suspicious/noUnusedExpressions: type-level assertions are compile-time only

import { describe, expectTypeOf, test } from "bun:test";

declare const defineRoute: typeof import("../../src/furin.ts").defineRoute;
declare const defineRootRoute: typeof import("../../src/furin.ts").defineRootRoute;

const createRootRoute = () =>
  defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => children);

const createSsrWithRevalidate = () =>
  defineRoute()
    .config(
      // @ts-expect-error — revalidate is only valid when mode is "isr".
      { layout: createRootRoute(), mode: "ssr", revalidate: 60 }
    )
    .page(() => null);

const createSsgWithRevalidate = () =>
  defineRoute()
    .config(
      // @ts-expect-error — revalidate is only valid when mode is "isr".
      { layout: createRootRoute(), mode: "ssg", revalidate: 60 }
    )
    .page(() => null);

const createSsrWithStaticParams = () =>
  defineRoute()
    .config(
      // @ts-expect-error — staticParams requires mode "ssg" or "isr".
      { layout: createRootRoute(), mode: "ssr", staticParams: () => [{}] }
    )
    .page(() => null);

const createIsrWithoutRevalidate = () =>
  defineRoute()
    .config(
      // @ts-expect-error — ISR requires an explicit revalidation interval.
      { layout: createRootRoute(), mode: "isr" }
    )
    .page(() => null);

const createIsrWithStaticParams = () =>
  defineRoute()
    .config({
      layout: createRootRoute(),
      mode: "isr",
      revalidate: 60,
      staticParams: () => [{}],
    })
    .page(() => null);

describe("defineRoute rendering mode config", () => {
  test("rejects revalidate outside ISR", () => {
    expectTypeOf<ReturnType<typeof createSsrWithRevalidate>>().not.toBeNever();
    expectTypeOf<ReturnType<typeof createSsgWithRevalidate>>().not.toBeNever();
  });

  test("rejects static params in SSR", () => {
    expectTypeOf<ReturnType<typeof createSsrWithStaticParams>>().not.toBeNever();
  });

  test("requires revalidate in ISR", () => {
    expectTypeOf<ReturnType<typeof createIsrWithoutRevalidate>>().not.toBeNever();
  });

  test("allows static params in ISR", () => {
    expectTypeOf<ReturnType<typeof createIsrWithStaticParams>>().not.toBeNever();
  });
});
