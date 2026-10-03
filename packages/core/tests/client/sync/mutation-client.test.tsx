import "../../setup/global.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { EdenFetchError } from "@elysia/eden";
import { Elysia, t } from "elysia";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createClient, useMutation, useQuery } from "../../../src/client.ts";
import { installDom, uninstallDom } from "../../support/dom.ts";

let root: Root | undefined;
beforeEach(() => installDom());
afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  await uninstallDom();
});

test.each([
  ["business", "Invalid title"],
  ["network", "Network unavailable"],
  ["unknown", "Mutation failed"],
])("a %s failure remains visible and retryable", async (kind, message) => {
  let attempts = 0;
  const networkError = new TypeError("Network unavailable");
  const businessError = { status: 422, value: { detail: "Invalid title" } };
  let observed: { status: number; value: { detail: string }; cause?: unknown } | undefined;
  const update = () => {
    attempts += 1;
    if (attempts === 1 && kind !== "business") {
      return Promise.reject(kind === "network" ? networkError : "Unknown failure");
    }
    return Promise.resolve({
      data: attempts === 1 ? null : "Saved",
      error: attempts === 1 ? businessError : null,
    });
  };
  function View() {
    const mutation = useMutation(update, {
      onError(error) {
        observed = error;
      },
    });
    const output = mutation.error ? mutation.error.value.detail : mutation.data;
    return (
      <>
        <button disabled={mutation.isPending} onClick={() => mutation.mutate()} type="button">
          Save
        </button>
        <button onClick={mutation.reset} type="button">
          Reset
        </button>
        <output>{output}</output>
      </>
    );
  }
  const container = document.createElement("div");
  root = createRoot(container);
  await act(() => root?.render(<View />));
  const buttons = container.querySelectorAll("button");
  await act(async () => {
    buttons[0]?.click();
    await Promise.resolve();
  });
  expect(container.querySelector("output")?.textContent).toBe(message);
  if (kind === "business") {
    expect(observed).toBe(businessError);
  } else {
    expect(observed?.status).toBe(0);
    expect(observed?.cause).toBe(kind === "network" ? networkError : "Unknown failure");
  }
  expect(buttons[0]?.disabled).toBe(false);
  await act(() => buttons[1]?.click());
  expect(container.querySelector("output")?.textContent).toBe("");
  await act(async () => {
    buttons[0]?.click();
    await Promise.resolve();
  });
  expect(container.querySelector("output")?.textContent).toBe("Saved");
});

test.each([
  { cause: new TypeError("Failed to fetch"), detail: "Failed to fetch" },
  { cause: "Offline", detail: "Mutation failed" },
])(
  "an Eden fetch failure is normalized instead of exposing its native payload",
  async ({ cause, detail }) => {
    const app = new Elysia().delete("/cards", () => ({ ok: true }));
    const api = createClient<typeof app>(window.location.origin, {
      fetcher: ((_input, _init) => Promise.reject(cause)) as typeof fetch,
    });
    let observed: unknown;
    function View() {
      const mutation = useMutation(api.cards.delete, {
        onError(error) {
          observed = error;
        },
      });
      return (
        <button onClick={() => mutation.mutate()} type="button">
          {mutation.error?.status ?? "Save"}
        </button>
      );
    }
    const container = document.createElement("div");
    root = createRoot(container);
    await act(() => root?.render(<View />));
    await act(async () => {
      container.querySelector("button")?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toBe("0");
    expect(observed).toMatchObject({ status: 0, value: { detail }, cause });
  }
);

test.each(["throw", "return", "success-callback"])(
  "a %s exception has the same Eden shape in onError, state and mutateAsync",
  async (source) => {
    const cause = new TypeError("Request failed");
    let observed: EdenFetchError<0, { detail: string }> | undefined;
    let rejected: Promise<unknown> | undefined;
    function View() {
      const mutation = useMutation(
        () => {
          if (source === "throw") {
            throw cause;
          }
          return Promise.resolve({ data: null, error: source === "return" ? cause : null });
        },
        {
          onSuccess() {
            if (source === "success-callback") {
              throw cause;
            }
          },
          onError(error) {
            observed = error;
          },
        }
      );
      return (
        <button
          disabled={mutation.isPending}
          onClick={() => {
            rejected = mutation.mutateAsync().catch((error: unknown) => error);
          }}
          type="button"
        >
          {mutation.error?.value.detail ?? "Save"}
        </button>
      );
    }
    const container = document.createElement("div");
    root = createRoot(container);
    await act(() => root?.render(<View />));
    const button = container.querySelector("button");
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(observed).toBeInstanceOf(EdenFetchError);
    expect(observed?.status).toBe(0);
    expect(observed?.value).toEqual({ detail: "Request failed" });
    expect(observed?.cause).toBe(cause);
    expect(await rejected).toBe(observed);
    expect(container.textContent).toBe("Request failed");
    expect(button?.disabled).toBe(false);
  }
);

test("parallel mutations keep pending until all finish and publish only the latest invocation", async () => {
  const first = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  const update = async (name: string) => ({
    data: await (name === "first" ? first.promise : second.promise),
    error: null,
  });
  function View() {
    const mutation = useMutation(update);
    return (
      <>
        <button onClick={() => mutation.mutate("first")} type="button">
          First
        </button>
        <button onClick={() => mutation.mutate("second")} type="button">
          Second
        </button>
        <output>
          {mutation.isPending ? "pending" : "idle"}:{mutation.data}
        </output>
      </>
    );
  }
  const container = document.createElement("div");
  root = createRoot(container);
  await act(() => root?.render(<View />));
  const buttons = container.querySelectorAll("button");
  await act(() => {
    buttons[0]?.click();
    buttons[1]?.click();
  });
  await act(async () => {
    second.resolve("newest");
    await second.promise;
  });
  expect(container.querySelector("output")?.textContent).toBe("pending:newest");
  await act(async () => {
    first.resolve("older");
    await first.promise;
  });
  expect(container.querySelector("output")?.textContent).toBe("idle:newest");
});

test("an Eden mutation exposes pending state and its typed response", async () => {
  const gate = Promise.withResolvers<void>();
  const app = new Elysia().post(
    "/cards",
    { body: t.Object({ title: t.String() }) },
    async ({ body }) => {
      await gate.promise;
      return { id: "1", title: body.title };
    }
  );
  const api = createClient<typeof app>(window.location.origin, {
    fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
  });
  function View() {
    const save = useMutation(api.cards.post);
    return (
      <button
        disabled={save.isPending}
        onClick={() => save.mutate({ title: "After" })}
        type="button"
      >
        {save.isPending ? "Saving" : (save.data?.title ?? "Save")}
      </button>
    );
  }
  const container = document.createElement("div");
  root = createRoot(container);
  await act(() => root?.render(<View />));
  const button = container.querySelector("button");
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
  expect(button?.disabled).toBe(true);
  expect(container.textContent).toBe("Saving");
  await act(async () => {
    gate.resolve();
    await gate.promise;
  });
  expect(button?.disabled).toBe(false);
  expect(container.textContent).toBe("After");
});

test("success callbacks are awaited by mutateAsync and keep the mutation pending", async () => {
  const navigation = Promise.withResolvers<void>();
  const response = { id: "1" };
  let saved: Promise<typeof response> | undefined;
  function View() {
    const mutation = useMutation(async () => ({ data: response, error: null }), {
      onSuccess: () => navigation.promise,
    });
    return (
      <button
        disabled={mutation.isPending}
        onClick={() => {
          saved = mutation.mutateAsync();
        }}
        type="button"
      >
        {mutation.data?.id ?? "Save"}
      </button>
    );
  }
  const container = document.createElement("div");
  root = createRoot(container);
  await act(() => root?.render(<View />));
  const button = container.querySelector("button");
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
  expect(button?.disabled).toBe(true);
  await act(async () => {
    navigation.resolve();
    expect(await saved).toBe(response);
  });
  expect(button?.disabled).toBe(false);
  expect(container.textContent).toBe("1");
});

test.each([409, 503])(
  "mutateAsync rejects the original HTTP %s error after its error callback",
  async (status) => {
    const failure = new EdenFetchError(status, { detail: "Rejected" });
    const callback = Promise.withResolvers<void>();
    let observed: typeof failure | EdenFetchError<0, { detail: string }> | undefined;
    let rejected: Promise<unknown> | undefined;
    function View() {
      const mutation = useMutation(async () => ({ data: null, error: failure }), {
        onError(error) {
          observed = error;
          return callback.promise;
        },
      });
      return (
        <button
          disabled={mutation.isPending}
          onClick={() => {
            rejected = mutation.mutateAsync().catch((error: unknown) => error);
          }}
          type="button"
        >
          Save
        </button>
      );
    }
    const container = document.createElement("div");
    root = createRoot(container);
    await act(() => root?.render(<View />));
    const button = container.querySelector("button");
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(observed).toBe(failure);
    expect(button?.disabled).toBe(true);
    await act(async () => {
      callback.resolve();
      expect(await rejected).toBe(failure);
    });
    expect(button?.disabled).toBe(false);
  }
);

test("reset clears the displayed result without aborting or publishing an older request", async () => {
  const gate = Promise.withResolvers<void>();
  function View() {
    const mutation = useMutation(async () => {
      await gate.promise;
      return { data: "Old result", error: null };
    });
    return (
      <>
        <button onClick={() => mutation.mutate()} type="button">
          Save
        </button>
        <button onClick={mutation.reset} type="button">
          Reset
        </button>
        <output>
          {mutation.isPending ? "pending" : "idle"}:{mutation.data}
        </output>
      </>
    );
  }
  const container = document.createElement("div");
  root = createRoot(container);
  await act(() => root?.render(<View />));
  const buttons = container.querySelectorAll("button");
  await act(() => buttons[0]?.click());
  await act(() => buttons.item(1).click());
  expect(container.querySelector("output")?.textContent).toBe("pending:");
  await act(async () => {
    gate.resolve();
    await gate.promise;
  });
  expect(container.querySelector("output")?.textContent).toBe("idle:");
});

test.each(["rejection", "retry"])(
  "Eden options preserve optimistic updates and %s semantics",
  async (outcome) => {
    const gate = Promise.withResolvers<void>();
    const keys: string[] = [];
    let title = "Before";
    const app = new Elysia()
      .get("/cards", () => [{ id: "1", title }])
      .patch("/cards", async ({ headers, status }) => {
        keys.push(headers["idempotency-key"] ?? "");
        if (outcome === "retry" && keys.length === 1) {
          return Response.json(
            { code: "FURIN_MUTATION_IN_PROGRESS" },
            {
              status: 409,
              headers: { "Retry-After": "0" },
            }
          );
        }
        await gate.promise;
        if (outcome === "rejection") {
          return status(422, { detail: "Rejected" });
        }
        title = "After";
        return { ok: true };
      });
    const api = createClient<typeof app>(window.location.origin, {
      retry: 1,
      fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
    });
    function View() {
      const query = useQuery(api.cards.get);
      const mutation = useMutation(api.cards.patch);
      return (
        <button
          disabled={mutation.isPending}
          onClick={() =>
            mutation.mutate(undefined, {
              optimistic(cache) {
                cache.update(api.cards.get, (cards) =>
                  cards.map((card) => ({ ...card, title: "After" }))
                );
              },
            })
          }
          type="button"
        >
          {query.data?.[0]?.title}
        </button>
      );
    }
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root?.render(<View />);
      await Promise.resolve();
    });
    expect(container.textContent).toBe("Before");
    const button = container.querySelector("button");
    await act(async () => {
      button?.click();
      await Bun.sleep(10);
    });
    expect(container.textContent).toBe("After");
    expect(button?.disabled).toBe(true);
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(container.textContent).toBe(outcome === "rejection" ? "Before" : "After");
    expect(button?.disabled).toBe(false);
    expect(keys).toHaveLength(outcome === "retry" ? 2 : 1);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).not.toBe("");
  }
);
