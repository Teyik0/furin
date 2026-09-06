import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { route as boardsRoute } from "./_route";

const params = t.Object({ id: t.String() });

export const route = defineRoute()
  .config({ layout: boardsRoute, mode: "isr", params, revalidate: 60 })
  .loader(async (context) => {
    const user = await (context as typeof context & { user: Promise<string> | string }).user;
    return { board: context.params.id, user };
  })
  .head(({ data }) => ({ meta: [{ title: `Board ${data.board}` }] }))
  .page(({ data }) => data.board);
