import "../../../packages/core/tests/setup/global.ts";
import { afterEach, expect, mock, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { withSync } from "@teyik0/furin/client";
import { RouterContext, SSR_FALLBACK_ROUTER } from "@teyik0/furin/link";
import { Elysia } from "elysia";
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
const app = new Elysia().patch("/cards/:id", ({ body }) => {
  submittedCards.push(body);
  return Response.json({ message: "Save rejected" }, { status: 422 });
});
mock.module("../src/lib/api", () => ({
  api: withSync(
    treaty<typeof app>(window.location.origin, {
      fetcher: ((input, init) => {
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

afterEach(() => {
  mutationFailure = undefined;
});

test.each([
  { action: "save", failure: "network" },
  { action: "delete", failure: "network" },
  { action: "save", failure: "invalid-json" },
  { action: "delete", failure: "invalid-json" },
  { action: "save", failure: "json-null" },
  { action: "delete", failure: "json-null" },
  { action: "save", failure: "navigation" },
  { action: "delete", failure: "navigation" },
])("shows a recoverable error after a $action $failure failure", async ({ action, failure }) => {
  if (failure === "network") {
    mutationFailure = new TypeError("Failed to fetch");
  } else if (failure === "navigation") {
    mutationFailure = Response.json({ ok: true });
  } else if (failure === "json-null") {
    mutationFailure = Response.json(null, { status: 502 });
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
          createElement(route.page, {
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
    const message =
      (failure === "json-null" || failure === "network") && action === "save"
        ? "Validation error"
        : `Could not ${action} the card. Please try again.`;
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
        createElement(route.page, {
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
    await waitForDom(() => container.textContent?.includes("Validation error") === true, {
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
        createElement(route.page, {
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
    await render(nextId, "Second");
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
