import type { NotFoundProps } from "@teyik0/furin";
import { notFound } from "@teyik0/furin";

export default function InnerNotFound({ error }: NotFoundProps): never {
  notFound(error);
}
