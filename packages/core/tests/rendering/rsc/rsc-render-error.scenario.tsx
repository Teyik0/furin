import type { Context } from "elysia";
import { createContext, createElement, useContext } from "react";
import { HeadContent, Scripts } from "../../../src/client/document.tsx";
import { createCompositeComponent, FurinRscRenderError } from "../../../src/rsc.tsx";
import { renderSSR } from "../../../src/server/render/index.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";

process.env.FURIN_RSC_CODEC_PATH = "";

const ReactContext = createContext("value");

function HookComponent() {
  return createElement("span", null, useContext(ReactContext));
}

let capturedError: unknown;
try {
  await createCompositeComponent(() => createElement(HookComponent));
} catch (error) {
  capturedError = error;
}

const resolved = {
  mode: "ssr",
  page: {
    __type: "FURIN_PAGE",
    component: () => null,
    loader: async () => ({
      source: await createCompositeComponent(() => createElement(HookComponent)),
    }),
  },
  path: "/rsc-error.tsx",
  pattern: "/rsc-error",
  routeChain: [],
  segmentBoundaries: [],
} as unknown as ResolvedRoute;
const root = {
  path: "/root.tsx",
  route: {
    __type: "FURIN_ROUTE",
    layout: ({ children }) =>
      createElement(
        "html",
        null,
        createElement("head", null, createElement(HeadContent)),
        createElement("body", null, children, createElement(Scripts))
      ),
  },
} satisfies RootLayout;
const context = {
  cookie: {},
  headers: {},
  params: {},
  path: "/rsc-error",
  query: {},
  redirect: (url: string) => new Response(null, { headers: { Location: url }, status: 302 }),
  request: new Request("http://localhost/rsc-error"),
  set: { headers: {} },
} as unknown as Context;
const response = await renderSSR(resolved, context, root, undefined);
const html = await response.text();

self.postMessage({
  causeIsTypeError:
    capturedError instanceof FurinRscRenderError && capturedError.cause instanceof TypeError,
  component: capturedError instanceof FurinRscRenderError ? capturedError.component : undefined,
  hook: capturedError instanceof FurinRscRenderError ? capturedError.hook : undefined,
  isFurinRscRenderError: capturedError instanceof FurinRscRenderError,
  message: capturedError instanceof Error ? capturedError.message : String(capturedError),
  routeHtml: html,
  routeStatus: response.status,
  stack: capturedError instanceof Error ? capturedError.stack : undefined,
  type: capturedError === undefined ? "unexpected-success" : "error",
});
