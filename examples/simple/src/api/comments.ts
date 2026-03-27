import { eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../db";
import { insertCommentSchema } from "../db/models";
import { comments } from "../db/schema";
import { authPlugin } from "./auth";

export const commentsPlugin = new Elysia({ name: "comments" })
  .use(authPlugin)
  .get(
    "/api/comments",
    ({ query }) =>
      db.select().from(comments).where(eq(comments.slug, query.slug)).orderBy(comments.createdAt),
    { query: t.Object({ slug: t.String() }) }
  )
  .post(
    "/api/comments",
    async ({ body, user }) => {
      const [comment] = await db
        .insert(comments)
        .values({
          id: crypto.randomUUID(),
          slug: body.slug,
          userId: user.id,
          userName: user.name,
          userImage: user.image ?? null,
          content: body.content,
          createdAt: new Date(),
        })
        .returning();
      return comment;
    },
    {
      body: t.Pick(insertCommentSchema, ["slug", "content"]),
      auth: true,
    }
  );
