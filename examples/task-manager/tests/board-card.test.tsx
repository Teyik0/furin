import { expect, mock, test } from "bun:test";
import {
  installDom,
  resetDomState,
  useDomTests as setupDomTests,
} from "../../../packages/core/tests/support/dom.ts";

installDom();
resetDomState();

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

setupDomTests();

const deleteCalls: unknown[][] = [];

mock.module("../src/lib/api", () => ({
  apiClient: {
    api: {
      boards: () => ({
        delete: (...args: unknown[]) => {
          deleteCalls.push(args);
          return Promise.resolve({ data: { ok: true }, error: null });
        },
      }),
    },
  },
  syncMutationHeaders: () => ({ "Idempotency-Key": "legacy-key" }),
}));

const { BoardCard } = await import("../src/components/board-card");

test("deletes a board with an idempotent Eden request", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.appendChild(container);

  try {
    await act(() =>
      root.render(
        createElement(BoardCard, {
          board: {
            createdAt: "2026-06-26T00:00:00.000Z",
            formattedCreatedAt: "Jun 26, 2026",
            id: "board-1",
            name: "Test board",
          },
        })
      )
    );
    const deleteButton = container.querySelector<HTMLButtonElement>('button[title="Delete board"]');
    expect(deleteButton).not.toBeNull();

    await act(async () => {
      deleteButton?.click();
      await Promise.resolve();
    });

    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]?.[0]).toBeUndefined();
    expect(deleteCalls[0]?.[1]).toEqual({
      headers: { "Idempotency-Key": expect.any(String) },
    });
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
