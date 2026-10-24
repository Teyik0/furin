import "../../../packages/core/tests/setup/global.ts";
import { beforeEach, expect, mock, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { furinSync } from "@teyik0/furin/client";
import {
  installDom,
  resetDomState,
  useDomTests as setupDomTests,
} from "../../../packages/core/tests/support/dom.ts";
import { type Api, api as serverApi } from "../src/api";
import { db } from "../src/db";
import { type Todo, todos } from "../src/db/schema";

installDom();
resetDomState();

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

setupDomTests();

// The component's Eden client reaches the real API in-process; `gate` holds requests in flight.
let gate: Promise<void> | undefined;
const idempotencyKeys: string[] = [];
mock.module("../src/lib/api", () => ({
  api: treaty<Api>("http://localhost", {
    fetcher: (async (input, init) => {
      await gate;
      const request = new Request(input, init);
      idempotencyKeys.push(request.headers.get("idempotency-key") ?? "");
      return serverApi.handle(request);
    }) as typeof fetch,
  }).use(furinSync).api,
}));

const { TodoApp } = await import("../src/components/todo-app");

beforeEach(() => {
  gate = undefined;
  idempotencyKeys.length = 0;
  db.delete(todos).run();
});

function seed(title: string, completed: boolean): Todo {
  return db
    .insert(todos)
    .values({ id: crypto.randomUUID(), title, completed, createdAt: new Date().toISOString() })
    .returning()
    .get();
}

function setInputValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
  setter?.call(element, value);
  const EventConstructor = document.defaultView?.Event ?? Event;
  element.dispatchEvent(new EventConstructor("input", { bubbles: true }));
}

async function settle() {
  await act(() => Bun.sleep(20));
}

async function mount(initial: Todo[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(createElement(TodoApp, { todos: initial })));
  const query = <T extends Element>(selector: string) => {
    const element = container.querySelector<T>(selector);
    if (!element) {
      throw new Error(`Missing ${selector}`);
    }
    return element;
  };
  return { container, query, unmount: () => act(() => root.unmount()) };
}

test("creates a trimmed todo and keeps a draft typed while the request was pending", async () => {
  const release = Promise.withResolvers<void>();
  gate = release.promise;
  const ui = await mount([]);
  try {
    const input = ui.query<HTMLInputElement>("#todo-title");
    const submit = ui.query<HTMLButtonElement>('button[type="submit"]');
    await act(() => setInputValue(input, "  Acheter du pain  "));
    await act(() => submit.click());

    expect(ui.query('[role="status"]').textContent).toBe("Enregistrement…");
    expect(submit.disabled).toBe(true);
    await act(() => setInputValue(input, "Suivante"));
    await act(async () => {
      release.resolve();
      await Bun.sleep(20);
    });

    expect(db.select().from(todos).all()).toMatchObject([{ title: "Acheter du pain" }]);
    expect(input.value).toBe("Suivante");
    expect(ui.query('[role="status"]').textContent).toBe("À jour");
  } finally {
    await ui.unmount();
  }
});

test("clears the draft once its todo is created", async () => {
  const ui = await mount([]);
  try {
    const input = ui.query<HTMLInputElement>("#todo-title");
    await act(() => setInputValue(input, "Appeler Léa"));
    await act(() => ui.query<HTMLButtonElement>('button[type="submit"]').click());
    await settle();

    expect(input.value).toBe("");
    expect(db.select().from(todos).all()).toMatchObject([{ title: "Appeler Léa" }]);
  } finally {
    await ui.unmount();
  }
});

test("toggles, renames and deletes a todo", async () => {
  const todo = seed("Original", false);
  const ui = await mount([todo]);
  try {
    await act(() => ui.query<HTMLInputElement>('input[type="checkbox"]').click());
    await settle();
    expect(db.select().from(todos).all()).toMatchObject([{ completed: true }]);

    await act(() => ui.query<HTMLButtonElement>('[aria-label="Modifier : Original"]').click());
    await act(() => setInputValue(ui.query("[aria-label='Modifier le titre']"), " Renommée "));
    await act(() => ui.query<HTMLButtonElement>(".todo-edit button[type=submit]").click());
    await settle();
    expect(db.select().from(todos).all()).toMatchObject([{ title: "Renommée" }]);

    await act(() => ui.query<HTMLButtonElement>('[aria-label="Supprimer : Original"]').click());
    await settle();
    expect(db.select().from(todos).all()).toEqual([]);
    // Every write is retry-safe: one fresh Idempotency-Key per mutation.
    expect(new Set(idempotencyKeys.filter(Boolean)).size).toBe(3);
  } finally {
    await ui.unmount();
  }
});

test("shows the server's problem detail when a mutation is rejected", async () => {
  const deleted: Todo = {
    id: "missing",
    title: "Supprimée ailleurs",
    completed: false,
    createdAt: "",
  };
  const ui = await mount([deleted]);
  try {
    await act(() => ui.query<HTMLInputElement>('input[type="checkbox"]').click());
    await settle();

    expect(ui.query('[role="alert"]').textContent).toBe("Todo not found");
  } finally {
    await ui.unmount();
  }
});

test("filters todos by status", async () => {
  const ui = await mount([seed("Active", false), seed("Faite", true)]);
  const titles = () =>
    [...ui.container.querySelectorAll(".todo-row-title")].map((row) => row.textContent);
  try {
    expect(titles()).toEqual(["Active", "Faite"]);
    await act(() => ui.query<HTMLButtonElement>(".todo-filters button:nth-child(2)").click());
    expect(ui.query("h1").textContent).toBe("À faire");
    expect(titles()).toEqual(["Active"]);
    await act(() => ui.query<HTMLButtonElement>(".todo-filters button:nth-child(3)").click());
    expect(titles()).toEqual(["Faite"]);
  } finally {
    await ui.unmount();
  }
});
