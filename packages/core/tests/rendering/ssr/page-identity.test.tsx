import { expect, test } from "bun:test";
import { t } from "elysia";
import { act, useState } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { buildPageElement } from "../../../src/client/router/boundary-tree.tsx";
import type { LoadedClientRoute } from "../../../src/client/router/types.ts";
import { defineRootRoute, defineRoute } from "../../../src/define-route.ts";
import { buildElement } from "../../../src/server/render/element.tsx";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";
import type { RemountDeps } from "../../../src/shared/page-key.ts";
import { useDomTests } from "../../support/dom.ts";

useDomTests();

type Identity = RemountDeps<{ id: number; tab: string }, { view: string }>;
const DOCUMENT_PATTERN = /^\/identity\/[^/]+\/[^/]+$/;
const policies: Array<{ name: string; remountDeps: Identity | undefined }> = [
  { name: "default", remountDeps: undefined },
  { name: "default schema edit", remountDeps: undefined },
  { name: "custom", remountDeps: ({ params }) => [params.id] },
  { name: "preserved", remountDeps: () => [] },
  { name: "negative zero default", remountDeps: undefined },
  { name: "negative zero custom", remountDeps: ({ params }) => [params.id] },
];

test.each(policies)(
  "$name page identity follows its remount policy through hydration and a data refresh",
  async ({ name, remountDeps }) => {
    const layout = defineRootRoute()
      .config({ mode: "ssr" })
      .layout(({ children }) => <section>{children}</section>);
    const definition = defineRoute()
      .config({
        layout,
        mode: "ssr",
        params: t.Object({ id: t.Number(), tab: t.String() }),
        query: t.Object({ view: t.String() }),
        remountDeps,
      })
      .loader(() => ({ title: "SSR" }))
      .page(({ title }) => {
        const [count, setCount] = useState(0);
        return (
          <button onClick={() => setCount((value) => value + 1)} type="button">
            {title} {count}
          </button>
        );
      });
    const rootLayout = adaptDefinedLayout(layout, undefined);
    const page = adaptDefinedPage(definition, rootLayout);
    const route: ResolvedRoute = {
      mode: "ssr",
      page,
      path: "/virtual/identity/[id]/[tab].tsx",
      pattern: "/identity/:id/:tab",
      routeChain: [rootLayout, page._route],
      segmentBoundaries: [],
    };
    const match: LoadedClientRoute = {
      component: page.component,
      load: () => Promise.resolve({ default: page }),
      pageRoute: page._route,
      pattern: route.pattern,
      regex: DOCUMENT_PATTERN,
    };
    const negativeZero = name.startsWith("negative zero");
    const refreshedId = name === "default schema edit" ? "42" : 42;
    const data = {
      params: { id: negativeZero ? -0 : 42, tab: "edit" },
      query: { view: "grid" },
      title: "SSR",
    };
    const container = document.createElement("div");
    container.innerHTML = renderToString(buildElement(route, data, rootLayout));
    document.body.appendChild(container);
    const errors: unknown[] = [];
    let root: Root | undefined;
    try {
      await act(() => {
        root = hydrateRoot(
          container,
          buildPageElement(match, rootLayout, data, undefined, undefined),
          {
            onRecoverableError: (error) => errors.push(error),
          }
        );
      });
      await act(() => container.querySelector<HTMLButtonElement>("button")?.click());
      expect(container.textContent).toBe("SSR 1");
      await act(() =>
        root?.render(
          buildPageElement(
            match,
            rootLayout,
            {
              params: {
                tab: "edit",
                id: negativeZero ? 0 : refreshedId,
              },
              query: { view: "list" },
              title: "Refreshed",
            },
            undefined,
            undefined
          )
        )
      );
      expect(container.textContent).toBe(negativeZero ? "Refreshed 0" : "Refreshed 1");
      expect(errors).toEqual([]);
    } finally {
      await act(() => root?.unmount());
      container.remove();
    }
  }
);
