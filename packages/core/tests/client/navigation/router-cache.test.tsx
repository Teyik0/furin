import "../../setup/global.ts";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toCrossJSON } from "seroval";
import { RouterProvider, useRouter } from "../../../src/client/link.tsx";
import type { ClientRoute } from "../../../src/client/router/index.ts";
import { Await, createClient, useQuery } from "../../../src/client.ts";
import { serializeRouteFrame, serializeRouteFrames } from "../../../src/shared/route-frame.ts";
import type { QuerySeed } from "../../../src/shared/sync-query.ts";
import { installDom, resetDomState, uninstallDom } from "../../support/dom.ts";

let root: Root | undefined;
let originalFetch: typeof fetch;
let router: ReturnType<typeof useRouter>;

beforeEach(() => {
  installDom();
  resetDomState();
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  globalThis.fetch = originalFetch;
  await uninstallDom();
});

function route(path: string, component: NonNullable<ClientRoute["component"]>): ClientRoute {
  return {
    load: async () => ({ default: { _route: {} as never, component } }),
    pattern: path,
    regex: new RegExp(`^${path}$`),
  };
}

async function mount(
  routes: [ClientRoute, ...ClientRoute[]],
  initialData: { __furinQueries?: QuerySeed[] }
) {
  const [first] = routes;
  const initial = await first.load();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const viewRoot = createRoot(container);
  root = viewRoot;
  await act(() => {
    viewRoot.render(
      <RouterProvider
        autoRefresh={false}
        basePath=""
        defaultPreload={false}
        defaultPreloadDelay={0}
        defaultPreloadStaleTime={30_000}
        initialData={initialData}
        initialDigest={undefined}
        initialMatch={{
          ...first,
          component: initial.default.component,
          pageRoute: initial.default._route,
        }}
        initialNotFound={undefined}
        prefetchCacheSize={50}
        root={null}
        routes={routes}
      />
    );
  });
  return container;
}

function response(data: object): Response {
  return new Response(`${JSON.stringify(toCrossJSON(data))}\n`, {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

test("returning to a page refetches its cancelled deferred transport", async () => {
  let reads = 0;
  function Home() {
    router = useRouter();
    return <main>Home</main>;
  }
  function Deferred({ slow }: { slow: Promise<string> }) {
    router = useRouter();
    return (
      <Suspense fallback="Pending">
        <Await resolve={slow}>{(value) => <main>{value}</main>}</Await>
      </Suspense>
    );
  }
  globalThis.fetch = Object.assign((input: RequestInfo | URL) => {
    const path = new URL(String(input), window.location.origin).searchParams.get("path");
    if (path === "/a") {
      reads += 1;
      if (reads === 1) {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(serializeRouteFrames({}, ["slow"])));
              },
            }),
            { headers: { "Content-Type": "application/x-ndjson" } }
          )
        );
      }
      return Promise.resolve(
        new Response(
          serializeRouteFrames({}, ["slow"]) +
            serializeRouteFrame({
              type: "defer-resolve",
              key: "slow",
              value: toCrossJSON("Ready"),
            }),
          { headers: { "Content-Type": "application/x-ndjson" } }
        )
      );
    }
    return Promise.resolve(response({}));
  }, originalFetch);
  const container = await mount(
    [route("/", Home), route("/a", Deferred as never), route("/b", Home)],
    {}
  );
  await act(() => router.navigate("/a"));
  expect(container.textContent).toBe("Pending");
  await act(() => router.navigate("/b"));
  await act(() => router.navigate("/a"));
  expect(reads).toBe(2);
  expect(container.textContent).toBe("Ready");
});

test("a prefetched loader cannot overwrite a GET completed after that prefetch", async () => {
  const identity = { id: "counter", scope: {}, session: "test" };
  const app = new Elysia().get("/counter", ({ set }) => {
    set.headers["x-furin-query"] = JSON.stringify(identity);
    return 1;
  });
  const api = createClient<typeof app>(window.location.origin, {
    fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
  });
  function Counter() {
    router = useRouter();
    return <main>{useQuery(api.counter.get).data}</main>;
  }
  const seed: QuerySeed = { url: `${window.location.origin}/counter`, identity, data: 0 };
  let prefetched = false;
  globalThis.fetch = Object.assign(() => {
    prefetched = true;
    return Promise.resolve(response({ __furinQueries: [seed] }));
  }, originalFetch);
  const container = await mount([route("/", Counter), route("/target", Counter)], {
    __furinQueries: [seed],
  });
  expect(container.textContent).toBe("0");
  await act(async () => {
    router.prefetch("/target");
    await Bun.sleep(0);
  });
  expect(prefetched).toBe(true);
  await act(async () => {
    await api.counter.get();
  });
  expect(container.textContent).toBe("1");
  await act(() => router.navigate("/target"));
  expect(window.location.pathname).toBe("/target");
  expect(container.textContent).toBe("1");
});

test.each(["page", "layout"] as const)(
  "%s invalidation evicts query variants while preserving unrelated prefetches",
  async (type) => {
    let value = "Before";
    let reads = 0;
    globalThis.fetch = Object.assign(() => {
      reads += 1;
      return Promise.resolve(response({ message: value }));
    }, originalFetch);
    function Page({ message }: { message?: unknown }) {
      router = useRouter();
      return <main>{String(message ?? "home")}</main>;
    }
    const container = await mount(
      [
        route("/", Page),
        route("/target", Page),
        route("/target/child", Page),
        route("/target-sibling", Page),
      ],
      {}
    );
    const variants = ["/target?filter=done", "/target?filter=todo"];
    const child = "/target/child?page=1";
    const sibling = "/target-sibling?page=1";
    await act(async () => {
      for (const href of [...variants, child, sibling]) {
        router.prefetch(href);
      }
      await Bun.sleep(0);
    });
    expect(reads).toBe(4);
    value = "After";
    router.invalidatePrefetch("/target", type);
    for (const href of variants) {
      // biome-ignore lint/performance/noAwaitInLoops: each navigation must commit before the next cached variant is checked.
      await act(() => router.navigate(href));
      expect(container.textContent).toBe("After");
    }
    await act(() => router.navigate(child));
    expect(container.textContent).toBe(type === "layout" ? "After" : "Before");
    await act(() => router.navigate(sibling));
    expect(container.textContent).toBe("Before");
    expect(reads).toBe(type === "layout" ? 7 : 6);
  }
);

test("an intercepted native anchor scrolls to the fragment after rendering its destination", async () => {
  globalThis.fetch = Object.assign(() => Promise.resolve(response({})), originalFetch);
  function Page() {
    return <a href="/target#heading">Target</a>;
  }
  function Target() {
    return <h2 id="heading">Heading</h2>;
  }
  const scrollIntoView = spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
    () => undefined
  );
  try {
    const container = await mount([route("/", Page), route("/target", Target)], {});
    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    await act(async () => {
      anchor?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Bun.sleep(0);
    });
    expect(window.location.pathname).toBe("/target");
    expect(window.location.hash).toBe("#heading");
    expect(container.querySelector("#heading")).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "instant", block: "start" });
  } finally {
    scrollIntoView.mockRestore();
  }
});
