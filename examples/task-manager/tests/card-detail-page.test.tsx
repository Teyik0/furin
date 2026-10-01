import "../../../packages/core/tests/setup/global.ts";
import { expect, mock, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { withSync } from "@teyik0/furin/client";
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
const app = new Elysia().patch("/cards/:id", ({ body }) => {
  submittedCards.push(body);
  return Response.json({ message: "Save rejected" }, { status: 422 });
});
mock.module("../src/lib/api", () => ({
  api: withSync(
    treaty<typeof app>(window.location.origin, {
      fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
    })
  ),
}));
const { route } = await import("../src/pages/board/[boardId]/card/[cardId]");

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
