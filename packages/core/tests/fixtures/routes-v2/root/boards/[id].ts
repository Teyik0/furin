import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

const params = t.Object({ id: t.String() });

export const route = defineRoute("/")
  .config({ mode: "isr", params, revalidate: 60 })
  .loader(async (context) => {
    const user = await (context as typeof context & { user: Promise<string> | string }).user;
    return { board: context.params.id, user };
  })
  .head(({ board }) => ({ meta: [{ title: `Board ${board}` }] }))
  .page(({ board }) => board);
