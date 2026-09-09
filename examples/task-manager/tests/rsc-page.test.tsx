import { afterAll, expect, mock, test } from "bun:test";
import { renderToReadableStream } from "react-dom/server";

mock.module("../src/api/modules/boards/service", () => ({
  createBoard: (name: string) => ({
    createdAt: "2026-05-01T00:00:00.000Z",
    id: "board-created",
    name,
  }),
  deleteBoard: (_boardId: string) => true,
  getBoardData: (_boardId: string) => null,
  getBoardStats: (_boardId: string) => null,
  getBoards: () => [
    {
      createdAt: "2026-05-01T00:00:00.000Z",
      id: "board-rsc",
      name: "RSC board",
    },
  ],
}));

afterAll(() => {
  const restorer = mock as typeof mock & { restoreModule?: (id?: string) => void };
  restorer.restoreModule?.("../src/api/modules/boards/service");
  mock.restore();
});

test("the RSC page renders server-owned boards with client interaction slots", async () => {
  const { route } = await import("../src/pages/rsc");
  const loaderData = await route.loader({} as never);

  expect(loaderData).toBeDefined();

  const Component = route.component;
  const stream = await renderToReadableStream(
    <Component data={loaderData} params={{}} path="/rsc" query={{}} />
  );
  const html = await new Response(stream).text();

  expect(html).toContain("RSC board");
  expect(html).toContain('aria-label="New board name"');
  expect(html).toContain('aria-label="Delete board-rsc"');
});
