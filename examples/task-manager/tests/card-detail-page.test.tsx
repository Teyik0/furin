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

const app = new Elysia().patch("/cards/:id", () =>
  Response.json({ message: "Save rejected" }, { status: 422 })
);
mock.module("../src/lib/api", () => ({
  api: withSync(
    treaty<typeof app>(window.location.origin, {
      fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
    })
  ),
}));
const { CardDetailPage } = await import("../src/components/card-detail-page");

test("a rejected save preserves the user's title and description", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        createElement(CardDetailPage, {
          boardName: "Board",
          card: {
            id: "card-1",
            boardId: "board-1",
            title: "Original",
            description: "Original description",
            createdAt: "2026-09-30",
          },
          formattedCreatedAt: "Sep 30",
          params: { boardId: "board-1", cardId: "card-1" },
          renderedAt: "12:00",
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
    title.value = "Edited title";
    description.value = "Edited description";
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
      await Promise.resolve();
    });
    await waitForDom(() => container.textContent?.includes("Could not save the card") === true, {
      timeoutMs: 2000,
    });
    expect(title.value).toBe("Edited title");
    expect(description.value).toBe("Edited description");
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
