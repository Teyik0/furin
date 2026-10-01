import "../../../packages/core/tests/setup/global.ts";
import { afterEach, expect, mock, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { withSync } from "@teyik0/furin/client";
import { RouterProvider, useRouter } from "@teyik0/furin/link";
import { Elysia } from "elysia";
import { serializeCompactJsonLine } from "../../../packages/core/src/shared/compact-json.ts";
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

interface Card {
  column: "backlog" | "todo" | "done";
  id: string;
  title: string;
}
interface MutationResult {
  data: object | null;
  error: { message: string } | null;
}
let resolveCreate: ((result: MutationResult) => void) | undefined;
let createFailure: Response | Error | undefined;
let resolveDelete: typeof resolveCreate;
let resolveMove: typeof resolveCreate;
let confirmedCards: Card[] = [];
let refresh: (() => Promise<void>) | undefined;
const boardPattern = /^\/board\/[^/]+$/;
const originalFetch = globalThis.fetch;
const boardIdentity = { id: "board", scope: { boardId: "board-1" }, session: "test" };

function boardData() {
  return {
    board: { id: "board-1", name: "Board" },
    cards: confirmedCards.map((card) => ({ ...card })),
  };
}

function response(result: MutationResult): Response {
  return Response.json(result.error ?? result.data, { status: result.error ? 422 : 200 });
}
const app = new Elysia()
  .get("/api/boards/:boardId", () =>
    Response.json(boardData(), {
      headers: {
        "x-furin-query": JSON.stringify(boardIdentity),
      },
    })
  )
  .post("/api/boards/:boardId/cards", async () =>
    response(
      await new Promise<MutationResult>((resolve) => {
        resolveCreate = resolve;
      })
    )
  )
  .delete("/api/cards/:id", async () =>
    response(
      await new Promise<MutationResult>((resolve) => {
        resolveDelete = resolve;
      })
    )
  )
  .patch("/api/cards/:id", async () =>
    response(
      await new Promise<MutationResult>((resolve) => {
        resolveMove = resolve;
      })
    )
  );

mock.module("../src/lib/api", () => ({
  api: withSync(
    treaty<typeof app>(window.location.origin, {
      fetcher: ((input, init) => {
        if (init?.method === "POST" && createFailure) {
          return createFailure instanceof Error
            ? Promise.reject(createFailure)
            : Promise.resolve(createFailure.clone());
        }
        return app.handle(new Request(input, init));
      }) as typeof fetch,
    })
  ).api,
}));
const { Kanban } = await import("../src/components/ui/kanban");
const { moveCard } = await import("../src/lib/card-mutations");

test("optimistic moves renumber both affected columns", () => {
  const cards = [
    { id: "a", title: "A", column: "todo" as const, position: 0 },
    { id: "b", title: "B", column: "todo" as const, position: 1 },
    { id: "c", title: "C", column: "done" as const, position: 0 },
    { id: "d", title: "D", column: "done" as const, position: 1 },
  ];
  const moved = moveCard(cards, "a", "done", "d");
  expect(moved?.nextCards.map(({ id, column, position }) => ({ id, column, position }))).toEqual([
    { id: "b", column: "todo", position: 0 },
    { id: "c", column: "done", position: 0 },
    { id: "a", column: "done", position: 1 },
    { id: "d", column: "done", position: 2 },
  ]);
});

function Page({ initialCards }: { initialCards: Card[] }) {
  const router = useRouter();
  refresh = () => router.refresh();
  return createElement(Kanban, { boardId: "board-1", initialCards: initialCards as never });
}

async function renderBoard(cards: Card[]) {
  window.history.replaceState(null, "", "/board/board-1");
  confirmedCards = cards;
  const querySeeds = () => [
    {
      url: `${window.location.origin}/api/boards/board-1`,
      identity: boardIdentity,
      bindings: [{ target: ["initialCards"], source: ["cards"] }],
      data: boardData(),
    },
  ];
  globalThis.fetch = (async () =>
    new Response(
      serializeCompactJsonLine({ initialCards: confirmedCards, __furinQueries: querySeeds() }),
      {
        headers: { "Content-Type": "application/x-ndjson" },
      }
    )) as unknown as typeof fetch;
  const route = {
    component: Page,
    load: async () => ({
      default: { component: Page, _route: { __type: "FURIN_ROUTE" } as never },
    }),
    pageRoute: { __type: "FURIN_ROUTE" } as never,
    pattern: "/board/:boardId",
    regex: boardPattern,
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      createElement(RouterProvider, {
        autoRefresh: true,
        basePath: "",
        defaultPreload: "intent",
        defaultPreloadDelay: 50,
        defaultPreloadStaleTime: 30_000,
        initialData: { initialCards: cards, __furinQueries: querySeeds() },
        initialDigest: undefined,
        initialMatch: route as never,
        initialNotFound: undefined,
        prefetchCacheSize: 50,
        root: null,
        routes: [route as never],
      })
    )
  );
  return {
    container,
    cleanup: async () => {
      await act(() => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  resolveCreate = undefined;
  createFailure = undefined;
  resolveDelete = undefined;
  resolveMove = undefined;
  refresh = undefined;
});

function setTextareaValue(element: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(
    element,
    value
  );
  const EventConstructor = document.defaultView?.Event ?? Event;
  element.dispatchEvent(new EventConstructor("input", { bubbles: true }));
  element.dispatchEvent(new EventConstructor("change", { bubbles: true }));
}

async function submitCard(container: Element, title: string) {
  const add = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Add card"
  );
  await act(() => add?.click());
  const input = container.querySelector<HTMLTextAreaElement>("textarea");
  expect(input).not.toBeNull();
  await act(() => {
    if (input) {
      setTextareaValue(input, title);
    }
  });
  await act(async () => {
    input?.closest("form")?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await Promise.resolve();
  });
}

async function dragCard(container: Element, destination: Element) {
  const card = container.querySelector('[draggable="true"]');
  const values = new Map<string, string>();
  const dataTransfer = {
    getData: (type: string) => values.get(type) ?? "",
    setData: (type: string, value: string) => {
      values.set(type, value);
    },
  };
  const dispatch = (element: Element, type: string) => {
    const EventConstructor = document.defaultView?.Event ?? Event;
    const event = new EventConstructor(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    element.dispatchEvent(event);
  };
  await act(async () => {
    if (card) {
      dispatch(card, "dragstart");
      dispatch(destination, "drop");
    }
    await Promise.resolve();
  });
}

test.each(["network", "empty", "text", "json-null", "invalid-json"])(
  "preserves the new-card draft after a %s failure",
  async (failure) => {
    if (failure === "network") {
      createFailure = new TypeError("Failed to fetch");
    } else if (failure === "json-null") {
      createFailure = Response.json(null, { status: 502 });
    } else {
      createFailure = new Response(failure === "empty" ? null : "Bad gateway", {
        status: 502,
        headers: failure === "invalid-json" ? { "Content-Type": "application/json" } : {},
      });
    }
    const board = await renderBoard([]);
    try {
      await submitCard(board.container, "My task draft");
      expect(board.container.textContent).toContain("Could not create the card. Please try again.");
      expect(board.container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
        "My task draft"
      );
      expect(
        board.container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled
      ).toBe(false);
    } finally {
      await board.cleanup();
    }
  }
);

test("creates an optimistic card through Eden and replaces it with confirmed loader props", async () => {
  const board = await renderBoard([]);
  try {
    await submitCard(board.container, "Optimistic task");
    const input = board.container.querySelector<HTMLTextAreaElement>("textarea");
    const submit = input
      ?.closest("form")
      ?.querySelector<HTMLButtonElement>('button[type="submit"]');
    const cancel = input
      ?.closest("form")
      ?.querySelector<HTMLButtonElement>('button[type="button"]');
    expect(input?.disabled).toBe(true);
    expect(submit?.disabled).toBe(true);
    expect(submit?.textContent).toContain("Adding…");
    expect(cancel?.disabled).toBe(true);
    expect(board.container.querySelectorAll('[draggable="true"]')).toHaveLength(1);
    expect(board.container.textContent).toContain("Optimistic task");
    await waitForDom(() => resolveCreate !== undefined, { timeoutMs: 2000 });
    confirmedCards = [{ id: "created", column: "backlog", title: "Optimistic task" }];
    await act(async () => {
      if (!resolveCreate) {
        throw new Error("Create request did not reach the server");
      }
      resolveCreate({ data: confirmedCards[0] ?? null, error: null });
      await Promise.resolve();
    });
    await waitForDom(
      () => board.container.querySelector('a[href="/board/board-1/card/created"]') !== null,
      { timeoutMs: 2000 }
    );
    expect(board.container.querySelectorAll('[draggable="true"]')).toHaveLength(1);
    expect(board.container.querySelector("textarea")).toBeNull();
  } finally {
    await board.cleanup();
  }
});

test("removes only a rejected optimistic insertion", async () => {
  const board = await renderBoard([]);
  try {
    await submitCard(board.container, "Rejected task");
    expect(board.container.querySelector('[draggable="true"]')?.textContent).toContain(
      "Rejected task"
    );
    await waitForDom(() => resolveCreate !== undefined, { timeoutMs: 2000 });
    await act(async () => {
      if (!resolveCreate) {
        throw new Error("Create request did not reach the server");
      }
      resolveCreate({ data: null, error: { message: "failed" } });
      await Promise.resolve();
    });
    expect(board.container.querySelector('[draggable="true"]')).toBeNull();
    expect(board.container.textContent).toContain("Could not create the card");
    const input = board.container.querySelector<HTMLTextAreaElement>("textarea");
    expect(input?.value).toBe("Rejected task");
    expect(input?.disabled).toBe(false);
    expect(
      input?.closest("form")?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled
    ).toBe(false);
  } finally {
    await board.cleanup();
  }
});

test("clears a rejected draft and its error when the add form is cancelled and reopened", async () => {
  const board = await renderBoard([]);
  try {
    await submitCard(board.container, "Rejected draft");
    await waitForDom(() => resolveCreate !== undefined, { timeoutMs: 2000 });
    await act(async () => {
      if (!resolveCreate) {
        throw new Error("Create request did not reach the server");
      }
      resolveCreate({ data: null, error: { message: "failed" } });
      await Promise.resolve();
    });
    expect(board.container.textContent).toContain("Could not create the card");
    const cancel = board.container
      .querySelector("textarea")
      ?.closest("form")
      ?.querySelector<HTMLButtonElement>('button[type="button"]');
    await act(() => cancel?.click());
    expect(board.container.querySelector("textarea")).toBeNull();
    const add = Array.from(board.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Add card"
    );
    await act(() => add?.click());
    expect(board.container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("");
    expect(board.container.textContent).not.toContain("Could not create the card");
  } finally {
    await board.cleanup();
  }
});

test("restores a card after a definitive deletion rejection", async () => {
  const board = await renderBoard([{ id: "1", column: "backlog", title: "Delete me" }]);
  try {
    const barrel = board.container.querySelector('button[aria-label^="Delete card"]');
    expect(barrel).not.toBeNull();
    if (barrel) {
      await dragCard(board.container, barrel);
    }
    expect(board.container.textContent).not.toContain("Delete me");
    await waitForDom(() => resolveDelete !== undefined, { timeoutMs: 2000 });
    await act(async () => {
      if (!resolveDelete) {
        throw new Error("Delete request did not reach the server");
      }
      resolveDelete({ data: null, error: { message: "failed" } });
      await Promise.resolve();
    });
    expect(board.container.textContent).toContain("Delete me");
    expect(board.container.textContent).toContain("Could not delete the card");
  } finally {
    await board.cleanup();
  }
});

test("moves a card through projected loader props and removes a rejected move", async () => {
  const board = await renderBoard([{ id: "1", column: "backlog", title: "Move me" }]);
  try {
    const columns = board.container.querySelectorAll("ul");
    await dragCard(board.container, columns.item(1));
    expect(columns.item(1).textContent).toContain("Move me");
    await waitForDom(() => resolveMove !== undefined, { timeoutMs: 2000 });
    await act(async () => {
      if (!resolveMove) {
        throw new Error("Move request did not reach the server");
      }
      resolveMove({ data: null, error: { message: "failed" } });
      await Promise.resolve();
    });
    expect(columns.item(0).textContent).toContain("Move me");
    expect(columns.item(1).textContent).not.toContain("Move me");
    expect(board.container.textContent).toContain("Could not move the card");
  } finally {
    await board.cleanup();
  }
});

test("renders remote inserts, moves and deletions from fresh loaders", async () => {
  const board = await renderBoard([{ id: "1", column: "backlog", title: "First" }]);
  try {
    confirmedCards = [
      { id: "1", column: "done", title: "First" },
      { id: "2", column: "todo", title: "Remote" },
    ];
    await act(async () => {
      await refresh?.();
    });
    expect(board.container.querySelectorAll("ul").item(3).textContent).toContain("First");
    expect(board.container.textContent).toContain("Remote");
    confirmedCards = [{ id: "1", column: "done", title: "First" }];
    await act(async () => {
      await refresh?.();
    });
    expect(board.container.textContent).not.toContain("Remote");
  } finally {
    await board.cleanup();
  }
});
