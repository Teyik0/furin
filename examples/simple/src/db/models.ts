import { createInsertSchema, createSelectSchema } from "drizzle-typebox";
import { comments } from "./schema";

export const insertCommentSchema = createInsertSchema(comments);
export const selectCommentSchema = createSelectSchema(comments);
