import "../../../packages/core/tests/setup/global.ts";
import { afterEach, expect, mock, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { withSync } from "@teyik0/furin/client";
import { Elysia } from "elysia";
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
let deleteResponse: Promise<Response> | undefined;
let transportFailure: Error | undefined;

const app = new Elysia().delete("/boards/:boardId", ({ headers, params }) => {
  deleteCalls.push([
    params.boardId,
    { headers: { "Idempotency-Key": headers["idempotency-key"] } },
  ]);
  return deleteResponse ?? { ok: true };
});
mock.module("../src/lib/api", () => ({
  api: withSync(
    treaty<typeof app>(window.location.origin, {
      fetcher: ((input, init) => {
        if (transportFailure) {
          return Promise.reject(transportFailure);
        }
        return app.handle(new Request(input, init));
      }) as typeof fetch,
    })
  ),
}));

const { BoardCard } = await import("../src/components/board-card");

afterEach(() => {
  deleteCalls.length = 0;
  deleteResponse = undefined;
  transportFailure = undefined;
});

test.each(["network", "json-null", "invalid-json"])(
  "keeps board deletion retryable after a %s failure",
  async (failure) => {
    if (failure === "network") {
      transportFailure = new TypeError("Failed to fetch");
    } else {
      deleteResponse = Promise.resolve(
        failure === "json-null"
          ? Response.json(null, { status: 502 })
          : new Response("invalid", {
              headers: { "Content-Type": "application/json" },
              status: 502,
            })
      );
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
          createElement(BoardCard, {
            board: {
              id: "board-1",
              name: "Board",
              createdAt: "2026-09-30",
              formattedCreatedAt: "Sep 30",
            },
          })
        )
      );
      const button = container.querySelector<HTMLButtonElement>('button[title="Delete board"]');
      await act(async () => {
        button?.click();
        await Promise.resolve();
      });
      expect(container.textContent).toContain("Could not delete the board. Please try again.");
      expect(button?.disabled).toBe(false);
      transportFailure = undefined;
      deleteResponse = undefined;
      await act(async () => {
        button?.click();
        await Promise.resolve();
      });
      expect(container.textContent).not.toContain("Could not delete the board.");
    } finally {
      await act(() => root.unmount());
      container.remove();
    }
  }
);

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
    expect(deleteCalls[0]?.[0]).toBe("board-1");
    expect(deleteCalls[0]?.[1]).toEqual({
      headers: { "Idempotency-Key": expect.any(String) },
    });
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

test("disables deletion while pending and allows retry after a rejection", async () => {
  const response = Promise.withResolvers<Response>();
  deleteResponse = response.promise;
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
    const button = container.querySelector<HTMLButtonElement>('button[title="Delete board"]');
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(button?.disabled).toBe(true);
    await act(() => button?.click());
    expect(deleteCalls).toHaveLength(1);

    await act(async () => {
      response.resolve(Response.json({ detail: "Delete rejected" }, { status: 422 }));
      await response.promise;
    });
    expect(button?.disabled).toBe(false);
    expect(container.textContent).toContain("Delete rejected");

    deleteResponse = undefined;
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(deleteCalls).toHaveLength(2);
    expect(container.textContent).not.toContain("Delete rejected");
  } finally {
    response.resolve(Response.json({ ok: true }));
    await act(() => root.unmount());
    container.remove();
  }
});
