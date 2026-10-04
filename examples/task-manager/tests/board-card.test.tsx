import "../../../packages/core/tests/setup/global.ts";
import { expect, mock, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { Elysia } from "elysia";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useDomTests as setupDomTests } from "../../../packages/core/tests/support/dom.ts";

setupDomTests();

const app = new Elysia().delete("/boards/:boardId", ({ status }) =>
  status(404, { detail: "Board not found" })
);
mock.module("../src/lib/api", () => ({
  api: treaty<typeof app>("http://localhost", {
    fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
  }),
}));
const { BoardCard } = await import("../src/components/board-card");

test("shows the API reason when deleting a board fails", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <BoardCard
          board={{
            id: "missing",
            name: "Project",
            createdAt: new Date(),
            formattedCreatedAt: "today",
          }}
        />
      )
    );
    await act(async () => {
      container.querySelector("button")?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Board not found");
    expect(container.querySelector("button")?.disabled).toBe(false);
  } finally {
    await act(() => root.unmount());
  }
});
