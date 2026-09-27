// biome-ignore-all lint/suspicious/noUnusedExpressions: type-level assertions are compile-time only

import { describe, expectTypeOf, test } from "bun:test";
import type { RouteLoaderData } from "../../src/furin.ts";

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
    .config({ layout: createRootRoute(), mode: "ssr" })
    // @ts-expect-error — staticParams is unavailable for SSR routes.
    .staticParams(() => [{}])
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
    })
    .staticParams(() => [{}])
    .page(() => null);

const createLegacyConfigStaticParams = () =>
  defineRoute()
    .config({
      layout: createRootRoute(),
      mode: "isr",
      revalidate: 60,
      // @ts-expect-error — staticParams is a builder stage, not route config.
      staticParams: () => [{}],
    })
    .page(() => null);

const createStaticParamsAfterLoader = () =>
  defineRoute()
    .config({ layout: createRootRoute(), mode: "ssg" })
    .loader(() => ({ ready: true }))
    // @ts-expect-error — staticParams must run before loader.
    .staticParams(() => [{}])
    .page(() => null);

const createStaticParamsAfterRequestLoader = () =>
  defineRoute()
    .config({ layout: createRootRoute(), mode: "ssg" })
    .requestLoader(() => ({ session: true }))
    // @ts-expect-error — staticParams must run before requestLoader.
    .staticParams(() => [{}])
    .page(() => null);

const createSsrLoaderWithRequest = () =>
  defineRoute()
    .config({ layout: createRootRoute(), mode: "ssr" })
    .loader(({ request, cookie, headers, set }) => ({
      cookie,
      headers,
      method: request.method,
      set,
    }))
    .page(() => null);

const createIsrLoaderWithPublicContext = () =>
  defineRoute()
    .config({ layout: createRootRoute(), mode: "isr", revalidate: 60 })
    .loader((context) => {
      // @ts-expect-error request-specific values cannot enter a shared cache.
      context.request;
      // @ts-expect-error cookies cannot enter a shared cache.
      context.cookie;
      // @ts-expect-error headers cannot enter a shared cache.
      context.headers;
      // @ts-expect-error response state cannot enter a shared cache.
      context.set;
      return { ready: context.path };
    })
    .page(() => null);

const createSsgLoaderWithPublicContext = () =>
  defineRoute()
    .config({ layout: createRootRoute(), mode: "ssg" })
    .loader((context) => {
      // @ts-expect-error request-specific values cannot enter a shared cache.
      context.request;
      return { ready: context.path };
    })
    .page(() => null);

const createSsrPageWithOwnRequestLoader = () =>
  defineRoute()
    .config({ layout: createRootRoute(), mode: "ssr" })
    .requestLoader(() => ({ user: "private" }))
    // @ts-expect-error SSR pages use loader() and defer() instead.
    .page(() => null);

const createSsrPageWithEmptyRequestLoader = () =>
  defineRoute()
    .config({ layout: createRootRoute(), mode: "ssr" })
    .requestLoader(() => ({}))
    // @ts-expect-error even a requestLoader with no fields is unavailable on SSR pages.
    .page(() => null);

const createSsrLayoutWithRequestLoader = () =>
  defineRootRoute()
    .config({ mode: "ssr" })
    .requestLoader(() => ({ user: "private" }))
    .layout(({ children }) => children);

const createPublicChildOfSsrLayout = () => {
  const root = defineRootRoute()
    .config({ mode: "ssr" })
    .loader(({ request }) => ({ session: request.headers.get("cookie") }))
    .layout(({ children }) => children);
  return defineRoute()
    .config({ layout: root, mode: "isr", revalidate: 60 })
    .staticParams((context) => {
      // @ts-expect-error request-scoped parent data cannot generate static paths.
      context.session;
      return [{}];
    })
    .loader((context) => {
      // @ts-expect-error request-scoped parent data cannot enter an ISR loader.
      context.session;
      return { catalog: "Coffee" };
    })
    .head((context) => {
      // @ts-expect-error request-scoped parent data cannot enter public metadata.
      context.session;
      return { meta: [] };
    })
    .page(({ session, catalog }) => {
      expectTypeOf(session).toEqualTypeOf<string | null>();
      expectTypeOf(catalog).toEqualTypeOf<string>();
      return null;
    });
};

const createPublicDataAcrossSsrLayout = () => {
  const root = defineRootRoute()
    .config({ mode: "ssg" })
    .loader(() => ({ siteName: "Furin" }))
    .layout(({ children }) => children);
  const privateLayout = defineRoute()
    .config({ layout: root, mode: "ssr" })
    .loader(({ request }) => ({ session: request.headers.get("cookie") }))
    .layout(({ children }) => children);
  return defineRoute()
    .config({ layout: privateLayout, mode: "isr", revalidate: 60 })
    .loader(async ({ siteName, ...context }) => {
      expectTypeOf(siteName).toEqualTypeOf<Promise<string>>();
      // @ts-expect-error the SSR segment's own result cannot enter public work.
      context.session;
      return { title: await siteName };
    })
    .page(({ siteName, session, title }) => {
      expectTypeOf(siteName).toEqualTypeOf<string>();
      expectTypeOf(session).toEqualTypeOf<string | null>();
      expectTypeOf(title).toEqualTypeOf<string>();
      return null;
    });
};

const createPublicOverrideOfSsrField = () => {
  const root = defineRootRoute()
    .config({ mode: "ssr" })
    .loader(() => ({ title: "private" as string }))
    .layout(({ children }) => children);
  const publicLayout = defineRoute()
    .config({ layout: root, mode: "isr", revalidate: 60 })
    .loader(() => ({ title: "public" as string }))
    .layout(({ children, title }) => {
      expectTypeOf(title).toEqualTypeOf<string>();
      return children;
    });
  return defineRoute()
    .config({ layout: publicLayout, mode: "isr", revalidate: 60 })
    .loader(({ title }) => {
      expectTypeOf(title).toEqualTypeOf<Promise<string>>();
      return {};
    })
    .page(() => null);
};

const createPrivateOverrideOfPublicField = () => {
  const root = defineRootRoute()
    .config({ mode: "ssg" })
    .loader(() => ({ title: "public" as string }))
    .layout(({ children }) => children);
  const privateLayout = defineRoute()
    .config({ layout: root, mode: "ssr" })
    .loader(() => ({ title: 42 }))
    .layout(({ children }) => children);
  return defineRoute()
    .config({ layout: privateLayout, mode: "isr", revalidate: 60 })
    .loader((context) => {
      // @ts-expect-error an override from an SSR loader remains private.
      context.title;
      return {};
    })
    .page(() => null);
};

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

  test("rejects static params in config", () => {
    expectTypeOf<ReturnType<typeof createLegacyConfigStaticParams>>().not.toBeNever();
  });

  test("rejects static params after a loader", () => {
    expectTypeOf<ReturnType<typeof createStaticParamsAfterLoader>>().not.toBeNever();
    expectTypeOf<ReturnType<typeof createStaticParamsAfterRequestLoader>>().not.toBeNever();
  });

  test("keeps request context in SSR loaders and removes it from cached loaders", () => {
    expectTypeOf<ReturnType<typeof createSsrLoaderWithRequest>>().not.toBeNever();
    expectTypeOf<ReturnType<typeof createIsrLoaderWithPublicContext>>().not.toBeNever();
    expectTypeOf<ReturnType<typeof createSsgLoaderWithPublicContext>>().not.toBeNever();
  });

  test("rejects a page-owned SSR request loader but allows a shared layout request loader", () => {
    expectTypeOf<ReturnType<typeof createSsrPageWithOwnRequestLoader>>().not.toBeNever();
    expectTypeOf<ReturnType<typeof createSsrPageWithEmptyRequestLoader>>().not.toBeNever();
    expectTypeOf<ReturnType<typeof createSsrLayoutWithRequestLoader>>().not.toBeNever();
  });

  test("keeps SSR ancestor data in rendering but excludes it from public work", () => {
    expectTypeOf<ReturnType<typeof createPublicChildOfSsrLayout>>().not.toBeNever();
    expectTypeOf<ReturnType<typeof createPublicDataAcrossSsrLayout>>().not.toBeNever();
    expectTypeOf<
      RouteLoaderData<ReturnType<typeof createPublicChildOfSsrLayout>>["session"]
    >().toEqualTypeOf<string | null>();
    expectTypeOf<ReturnType<typeof createPublicOverrideOfSsrField>>().not.toBeNever();
    expectTypeOf<ReturnType<typeof createPrivateOverrideOfPublicField>>().not.toBeNever();
  });
});
