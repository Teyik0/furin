import "../../../packages/core/tests/setup/global.ts";
import { afterAll, expect, test } from "bun:test";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import {
  CLIENT_FALLBACK_ROUTER,
  RouterContext,
} from "../../../packages/core/src/client/router/context";
import { installDom, resetDomState, uninstallDom } from "../../../packages/core/tests/support/dom";
import { createTodoBackend } from "../src/todo-backend";
import type { Todo } from "../src/todo-types";

installDom();
resetDomState();

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TodoScreen } = await import("../src/ui/todo-screen");

// Keep the DOM installed until every root and in-flight request is cleaned up.
afterAll(uninstallDom);

const eventsKey = Symbol.for("furin.browser-events.runtime");
const mutationFailure = /mutation failed/i;
const runtimeGlobal = globalThis as typeof globalThis & {
  [eventsKey]?: {
    subscribeStatus: (listener: (status: "connected") => void) => () => boolean;
  };
};

function setInputValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
  setter?.call(element, value);
  const EventConstructor = document.defaultView?.Event ?? Event;
  element.dispatchEvent(new EventConstructor("input", { bubbles: true }));
  element.dispatchEvent(new EventConstructor("change", { bubbles: true }));
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the todo UI");
    }
    // biome-ignore lint/performance/noAwaitInLoops: let real HTTP responses and React updates settle
    await act(async () => {
      await Bun.sleep(5);
    });
  }
}

async function mountTodos(seedTitles: string[]) {
  resetDomState();
  let backend: ReturnType<typeof createTodoBackend> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let root: ReturnType<typeof createRoot> | undefined;
  const previousRuntime = runtimeGlobal[eventsKey];
  const container = document.createElement("div");
  const gates: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  let closed = false;
  let held:
    | {
        method: "GET" | "POST" | "PATCH";
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  let writes = 0;
  const requests = new Set<Promise<Response>>();
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    for (const gate of gates) {
      gate.resolve();
    }
    try {
      await act(async () => {
        await Promise.allSettled(requests);
        root?.unmount();
      });
    } finally {
      container.remove();
      if (previousRuntime) {
        runtimeGlobal[eventsKey] = previousRuntime;
      } else {
        delete runtimeGlobal[eventsKey];
      }
      try {
        await server?.stop(true);
      } finally {
        backend?.close();
      }
    }
  };
  try {
    backend = createTodoBackend(":memory:");
    const app = new Elysia().use(furinSync(backend.sync)).use(backend.api);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const response = (async () => {
          if (request.method === "POST" || request.method === "PATCH") {
            writes += 1;
          }
          const gate = held;
          if (gate?.method === request.method) {
            held = undefined;
            gate.entered.resolve();
            await gate.release.promise;
          }
          return app.handle(request);
        })();
        requests.add(response);
        response.then(
          () => requests.delete(response),
          () => requests.delete(response)
        );
        return response;
      },
    });
    const { origin } = server.url;
    const browser = window as typeof window & { happyDOM: { setURL: (url: string) => void } };
    browser.happyDOM.setURL(`${origin}/`);
    const list = async (): Promise<Todo[]> => {
      const response = await fetch(`${origin}/api/todos`);
      expect(response.status).toBe(200);
      return response.json();
    };
    for (const title of seedTitles) {
      // biome-ignore lint/performance/noAwaitInLoops: seed through the public API before mounting
      const response = await fetch(`${origin}/api/todos`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ title }),
      });
      expect(response.status).toBe(200);
    }
    writes = 0;
    let todos = await list();
    runtimeGlobal[eventsKey] = {
      subscribeStatus(listener) {
        listener("connected");
        return () => true;
      },
    };
    let projectionFailure: Error | undefined;
    document.body.appendChild(container);
    const mountedRoot = createRoot(container);
    root = mountedRoot;
    const refresh = async () => {
      if (projectionFailure) {
        throw projectionFailure;
      }
      todos = await list();
      render();
    };
    const render = () =>
      mountedRoot.render(
        createElement(
          RouterContext.Provider,
          { value: { ...CLIENT_FALLBACK_ROUTER, refresh } },
          createElement(TodoScreen, { todos })
        )
      );
    await act(render);
    await eventually(
      () => container.querySelector('[data-testid="sync-status"]')?.textContent === "À jour"
    );
    const control = <T extends HTMLElement>(id: string): T => {
      const element = container.querySelector<T>(`[data-testid="${id}"]`);
      expect(element).not.toBeNull();
      return element as T;
    };
    return {
      container,
      control,
      list,
      get writes() {
        return writes;
      },
      failProjection(error: Error | undefined) {
        projectionFailure = error;
      },
      hold(method: "GET" | "POST" | "PATCH") {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        gates.push(release);
        held = { method, entered, release };
        return { entered: entered.promise, release: () => release.resolve() };
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {
      // Preserve the setup failure even if disposing an acquired resource fails.
    });
    throw error;
  }
}

test("a post-write refresh keeps an already ready transport connected", async () => {
  const ui = await mountTodos([]);
  const refresh = ui.hold("GET");
  try {
    await act(() => setInputValue(ui.control<HTMLInputElement>("todo-title"), "Silent refresh"));
    await act(async () => {
      ui.control<HTMLButtonElement>("add-todo").click();
      await refresh.entered;
    });
    expect(ui.control<HTMLElement>("sync-status").textContent).toBe("À jour");
    refresh.release();
    await eventually(
      () => ui.container.querySelector(".todo-row-title")?.textContent === "Silent refresh"
    );
  } finally {
    refresh.release();
    await ui.close();
  }
});

test("a committed create preserves a newer draft typed while its HTTP request is pending", async () => {
  const ui = await mountTodos([]);
  const request = ui.hold("POST");
  try {
    const input = ui.control<HTMLInputElement>("todo-title");
    await act(() => setInputValue(input, "  Submitted task  "));
    await act(async () => {
      ui.control<HTMLButtonElement>("add-todo").click();
      await request.entered;
    });
    expect(ui.control<HTMLButtonElement>("add-todo").disabled).toBe(true);
    expect(input.disabled).toBe(false);
    await act(() => setInputValue(input, "My next task"));
    request.release();
    await eventually(
      () => ui.container.querySelector(".todo-row-title")?.textContent === "Submitted task"
    );
    expect(input.value).toBe("My next task");
    const todos = await ui.list();
    expect(todos).toHaveLength(1);
    expect(todos[0]?.title).toBe("Submitted task");
    expect(ui.container.textContent).toContain("Submitted task");
    expect(ui.container.querySelector('[data-testid="todo-error"]')).toBeNull();
    expect(ui.writes).toBe(1);
  } finally {
    await ui.close();
  }
});

test("a failed snapshot projection does not turn a committed create into a failed mutation", async () => {
  const ui = await mountTodos([]);
  try {
    ui.failProjection(new Error("Snapshot projection unavailable"));
    const input = ui.control<HTMLInputElement>("todo-title");
    await act(() => setInputValue(input, "Committed once"));
    await act(() => ui.control<HTMLButtonElement>("add-todo").click());
    await eventually(() => ui.container.querySelector('[data-testid="todo-error"]') !== null);
    expect(await ui.list()).toEqual([
      {
        id: expect.any(String),
        createdAt: expect.any(String),
        completed: false,
        title: "Committed once",
      },
    ]);
    expect(ui.writes).toBe(1);
    expect(input.value).toBe("");
    const error = ui.control<HTMLParagraphElement>("todo-error").textContent;
    expect(error).toContain("Synchronisation :");
    expect(error).toContain("Snapshot projection unavailable");
    expect(error).not.toMatch(mutationFailure);

    ui.failProjection(undefined);
    await eventually(() => ui.container.querySelector('[data-testid="todo-error"]') === null);
    await eventually(
      () => ui.container.querySelector(".todo-row-title")?.textContent === "Committed once"
    );
    expect(await ui.list()).toHaveLength(1);
    expect(ui.writes).toBe(1);
    await act(() => setInputValue(input, "After recovery"));
    expect(ui.control<HTMLButtonElement>("add-todo").disabled).toBe(false);
    await act(() => ui.control<HTMLButtonElement>("add-todo").click());
    await eventually(() => ui.container.querySelectorAll(".todo-row-title").length === 2);
    expect((await ui.list()).map((todo) => todo.title)).toEqual([
      "Committed once",
      "After recovery",
    ]);
    expect(input.value).toBe("");
    expect(ui.container.querySelector('[data-testid="todo-error"]')).toBeNull();
    expect(ui.writes).toBe(2);
  } finally {
    await ui.close();
  }
});

test("a committed edit preserves the editor and newer draft typed during its HTTP request", async () => {
  const ui = await mountTodos(["Original title"]);
  const request = ui.hold("PATCH");
  try {
    const [todo] = await ui.list();
    expect(todo).toBeDefined();
    const id = todo?.id as string;
    await act(() => ui.control<HTMLButtonElement>(`edit-${id}`).click());
    const input = ui.control<HTMLInputElement>(`edit-title-${id}`);
    await act(() => setInputValue(input, "  Submitted title  "));
    await act(async () => {
      ui.control<HTMLButtonElement>(`save-${id}`).click();
      await request.entered;
    });
    expect(ui.control<HTMLButtonElement>(`save-${id}`).disabled).toBe(true);
    expect(input.disabled).toBe(false);
    await act(() => setInputValue(input, "Newer edit draft"));
    request.release();
    await eventually(
      () => ui.control<HTMLElement>("sync-status").textContent?.includes("À jour") === true
    );
    expect(ui.control<HTMLInputElement>(`edit-title-${id}`).value).toBe("Newer edit draft");
    expect(ui.control<HTMLButtonElement>(`save-${id}`).disabled).toBe(false);
    expect(await ui.list()).toEqual([{ ...todo, title: "Submitted title" }]);
    expect(ui.container.querySelector('[data-testid="todo-error"]')).toBeNull();
    expect(ui.writes).toBe(1);
  } finally {
    await ui.close();
  }
});
