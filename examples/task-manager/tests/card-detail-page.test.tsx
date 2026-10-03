import "../../../packages/core/tests/setup/global.ts";
import { afterEach, expect, mock, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { withSync } from "@teyik0/furin/client";
import { RouterContext, SSR_FALLBACK_ROUTER } from "@teyik0/furin/link";
import { Elysia } from "elysia";
import { buildPageElement } from "../../../packages/core/src/client/router/boundary-tree.tsx";
import type { LoadedClientRoute } from "../../../packages/core/src/client/router/types.ts";
import { adaptDefinedPage } from "../../../packages/core/src/server/router/defined-route.ts";
import {
  installDom,
  resetDomState,
  useDomTests as setupDomTests,
  waitForDom,
} from "../../../packages/core/tests/support/dom.ts";

installDom();
resetDomState();
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
setupDomTests();

const submittedCards: unknown[] = [];
let mutationFailure: Response | Error | undefined;
let pendingMutation: Promise<Response> | undefined;
let mutationRequests = 0;
const app = new Elysia().patch("/cards/:id", ({ body }) => {
  submittedCards.push(body);
  return Response.json({ message: "Save rejected" }, { status: 422 });
});
mock.module("../src/lib/api", () => ({
  api: withSync(
    treaty<typeof app>(window.location.origin, {
      fetcher: ((input, init) => {
        mutationRequests += 1;
        if (pendingMutation) {
          return pendingMutation;
        }
        if (mutationFailure) {
          return mutationFailure instanceof Error
            ? Promise.reject(mutationFailure)
            : Promise.resolve(mutationFailure.clone());
        }
        return app.handle(new Request(input, init));
      }) as typeof fetch,
    })
  ),
}));
const { route } = await import("../src/pages/board/[boardId]/card/[cardId]");
const page = adaptDefinedPage(route, { __type: "FURIN_ROUTE" });
const match: LoadedClientRoute = {
  component: page.component,
  load: () => Promise.resolve({ default: page }),
  pageRoute: page._route,
  pattern: "/board/:boardId/card/:cardId",
  regex: /^\/board\/[^/]+\/card\/[^/]+$/,
};

function CardPage(props: Parameters<typeof route.page>[0]) {
  return buildPageElement(match, null, props, undefined, undefined);
}

afterEach(() => {
  mutationFailure = undefined;
  pendingMutation = undefined;
  mutationRequests = 0;
});

test("card mutations disable both actions while pending and allow retry after rejection", async () => {
  const response = Promise.withResolvers<Response>();
  pendingMutation = response.promise;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        createElement(CardPage, {
          boardName: "Board",
          formattedCreatedAt: "Sep 30",
          renderedAt: "12:00",
          sidebarBoards: [],
          params: { boardId: "board-1", cardId: "card-1" },
          card: {
            id: "card-1",
            boardId: "board-1",
            column: "todo",
            title: "Draft",
            description: "Draft description",
            createdAt: "2026-09-30",
            position: 0,
          },
        })
      )
    );
    const remove = container.querySelector<HTMLButtonElement>('button[type="button"]');
    const save = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    await act(async () => {
      remove?.click();
      await Promise.resolve();
    });
    await act(() => {
      remove?.click();
      save?.click();
    });
    expect(mutationRequests).toBe(1);
    expect(remove?.disabled).toBe(true);
    expect(save?.disabled).toBe(true);
    await act(async () => {
      response.resolve(Response.json({ detail: "Delete rejected" }, { status: 422 }));
      await response.promise;
    });
    expect(container.textContent).toContain("Delete rejected");
    expect(remove?.disabled).toBe(false);
    expect(save?.disabled).toBe(false);
    pendingMutation = undefined;
    mutationFailure = Response.json({ detail: "Retry rejected" }, { status: 422 });
    await act(async () => {
      remove?.click();
      await Promise.resolve();
    });
    expect(mutationRequests).toBe(2);
    expect(container.textContent).toContain("Retry rejected");
  } finally {
    response.resolve(Response.json({ ok: true }));
    await act(() => root.unmount());
    container.remove();
  }
});

test.each(["save", "delete"])(
  "switching to %s keeps each error beside its own action",
  async (action) => {
    const response = Promise.withResolvers<Response>();
    const container = document.createElement("div");
    const root = createRoot(container);
    document.body.appendChild(container);
    try {
      await act(() =>
        root.render(
          createElement(CardPage, {
            boardName: "Board",
            formattedCreatedAt: "Sep 30",
            renderedAt: "12:00",
            sidebarBoards: [],
            params: { boardId: "board-1", cardId: "card-1" },
            card: {
              id: "card-1",
              boardId: "board-1",
              column: "todo",
              title: "Draft",
              description: "Draft description",
              createdAt: "2026-09-30",
              position: 0,
            },
          })
        )
      );
      const save = container.querySelector<HTMLButtonElement>('button[type="submit"]');
      const remove = container.querySelector<HTMLButtonElement>('button[type="button"]');
      const first = action === "save" ? remove : save;
      const second = action === "save" ? save : remove;
      mutationFailure = Response.json({ detail: "Previous failure" }, { status: 422 });
      await act(async () => {
        first?.click();
        await Promise.resolve();
      });
      expect(container.textContent).toContain("Previous failure");
      expect(first?.parentElement?.querySelector('[role="alert"]')?.textContent).toBe(
        "Previous failure"
      );
      expect(second?.parentElement?.querySelector('[role="alert"]')).toBeNull();
      pendingMutation = response.promise;
      await act(async () => {
        second?.click();
        await Promise.resolve();
      });
      expect(first?.parentElement?.querySelector('[role="alert"]')?.textContent).toBe(
        "Previous failure"
      );
      expect(second?.parentElement?.querySelector('[role="alert"]')).toBeNull();
      await act(async () => {
        response.resolve(Response.json({ detail: "Current failure" }, { status: 422 }));
        await response.promise;
      });
      expect(first?.parentElement?.querySelector('[role="alert"]')?.textContent).toBe(
        "Previous failure"
      );
      expect(second?.parentElement?.querySelector('[role="alert"]')?.textContent).toBe(
        "Current failure"
      );
      pendingMutation = undefined;
      mutationFailure = Response.json({ detail: "Final failure" }, { status: 422 });
      await act(async () => {
        first?.click();
        await Promise.resolve();
      });
      expect(first?.parentElement?.querySelector('[role="alert"]')?.textContent).toBe(
        "Final failure"
      );
      expect(second?.parentElement?.querySelector('[role="alert"]')?.textContent).toBe(
        "Current failure"
      );
    } finally {
      response.resolve(Response.json({ ok: true }));
      await act(() => root.unmount());
      container.remove();
    }
  }
);

test.each([
  { action: "save", failure: "network" },
  { action: "delete", failure: "network" },
  { action: "save", failure: "invalid-json" },
  { action: "delete", failure: "invalid-json" },
  { action: "save", failure: "json-null" },
  { action: "delete", failure: "json-null" },
  { action: "save", failure: "server" },
  { action: "save", failure: "validation" },
  { action: "save", failure: "navigation" },
  { action: "delete", failure: "navigation" },
])("shows a recoverable error after a $action $failure failure", async ({ action, failure }) => {
  if (failure === "network") {
    mutationFailure = new TypeError("Failed to fetch");
  } else if (failure === "navigation") {
    mutationFailure = Response.json({ ok: true });
  } else if (failure === "json-null") {
    mutationFailure = Response.json(null, { status: 502 });
  } else if (failure === "server") {
    mutationFailure = Response.json({ message: "Bad gateway" }, { status: 502 });
  } else if (failure === "validation") {
    mutationFailure = Response.json({ detail: "Title is invalid" }, { status: 422 });
  } else {
    mutationFailure = new Response("invalid", {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
  const navigate = mock(() => Promise.reject(new Error("Navigation failed")));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        createElement(
          RouterContext.Provider,
          { value: { ...SSR_FALLBACK_ROUTER, navigate } },
          createElement(CardPage, {
            boardName: "Board",
            formattedCreatedAt: "Sep 30",
            renderedAt: "12:00",
            sidebarBoards: [],
            params: { boardId: "board-1", cardId: "card-1" },
            card: {
              id: "card-1",
              boardId: "board-1",
              column: "todo",
              title: "Draft",
              description: "Draft description",
              createdAt: "2026-09-30",
              position: 0,
            },
          })
        )
      )
    );
    await act(async () => {
      const button =
        action === "save"
          ? container.querySelector<HTMLButtonElement>('button[type="submit"]')
          : Array.from(container.querySelectorAll("button")).find((item) =>
              item.textContent?.includes("Delete card")
            );
      expect(button).toBeDefined();
      button?.click();
      await Promise.resolve();
    });
    let message = `Could not ${action} the card. Please try again.`;
    if (failure === "validation") {
      message = "Title is invalid";
    } else if (failure === "network") {
      message = "Failed to fetch";
    } else if (failure === "navigation") {
      message = "Navigation failed";
    } else if (failure === "invalid-json") {
      message = 'JSON Parse error: Unexpected identifier "invalid"';
    }
    await waitForDom(() => container.textContent?.includes(message) === true, { timeoutMs: 2000 });
    expect(container.textContent).toContain(message);
    expect(container.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe("Draft");
    expect(navigate).toHaveBeenCalledTimes(failure === "navigation" ? 1 : 0);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

function setFieldValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
  setter?.call(element, value);
  const EventConstructor = document.defaultView?.Event ?? Event;
  element.dispatchEvent(new EventConstructor("input", { bubbles: true }));
  element.dispatchEvent(new EventConstructor("change", { bubbles: true }));
}

test("a rejected save preserves the user's title and description", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        createElement(CardPage, {
          boardName: "Board",
          card: {
            id: "card-1",
            boardId: "board-1",
            column: "todo",
            title: "Original",
            description: "Original description",
            createdAt: "2026-09-30",
            position: 0,
          },
          formattedCreatedAt: "Sep 30",
          params: { boardId: "board-1", cardId: "card-1" },
          renderedAt: "12:00",
          sidebarBoards: [],
        })
      )
    );
    const title = container.querySelector<HTMLInputElement>('input[name="title"]');
    const description = container.querySelector<HTMLTextAreaElement>(
      'textarea[name="description"]'
    );
    if (!(title && description)) {
      throw new Error("Missing card form fields");
    }
    await act(() => {
      setFieldValue(title, "Edited title");
      setFieldValue(description, "Edited description");
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
      await Promise.resolve();
    });
    await waitForDom(() => container.textContent?.includes("Could not save the card") === true, {
      timeoutMs: 2000,
    });
    expect(submittedCards.at(-1)).toEqual({
      description: "Edited description",
      title: "Edited title",
    });
    expect(title.value).toBe("Edited title");
    expect(description.value).toBe("Edited description");
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

test.each([
  { label: "another card", id: "card-2", edited: false },
  { label: "a refreshed card", id: "card-1", edited: false },
  { label: "a refreshed card while editing", id: "card-1", edited: true },
  { label: "another card while editing", id: "card-2", edited: true },
])("loading $label preserves only same-card edits", async ({ id: nextId, edited }) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (id: string, title: string) =>
    act(() =>
      root.render(
        createElement(CardPage, {
          boardName: "Board",
          formattedCreatedAt: "Sep 30",
          renderedAt: "12:00",
          sidebarBoards: [],
          params: { boardId: "board-1", cardId: id },
          card: {
            id,
            title,
            boardId: "board-1",
            column: "todo",
            description: `${title} description`,
            createdAt: "2026-09-30",
            position: 0,
          },
        })
      )
    );
  try {
    await render("card-1", "First");
    if (edited) {
      await act(() => {
        const title = container.querySelector<HTMLInputElement>('input[name="title"]');
        const description = container.querySelector<HTMLTextAreaElement>(
          'textarea[name="description"]'
        );
        if (!(title && description)) {
          throw new Error("Missing card form fields");
        }
        setFieldValue(title, "Draft");
        setFieldValue(description, "Draft description");
      });
    }
    mutationFailure = Response.json({ detail: "Previous error" }, { status: 422 });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Previous error");
    await render(nextId, "Second");
    if (nextId === "card-1") {
      expect(container.textContent).toContain("Previous error");
    } else {
      expect(container.textContent).not.toContain("Previous error");
    }
    const expected = edited && nextId === "card-1" ? "Draft" : "Second";
    expect(container.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe(expected);
    expect(
      container.querySelector<HTMLTextAreaElement>('textarea[name="description"]')?.value
    ).toBe(`${expected} description`);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
