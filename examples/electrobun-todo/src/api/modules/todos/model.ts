import { t, type UnwrapModels } from "elysia";

// At least one non-blank character; the service stores the trimmed title.
const title = t.String({ minLength: 1, maxLength: 200, pattern: "\\S" });

export const Post = {
  Body: t.Object({ title }),
};

export const ByIdPatch = {
  Body: t.Object(
    { title: t.Optional(title), completed: t.Optional(t.Boolean()) },
    { additionalProperties: false, minProperties: 1 }
  ),
};
export type ByIdPatch = UnwrapModels<typeof ByIdPatch>;
