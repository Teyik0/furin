import type { ErrorProps } from "@teyik0/furin";

export default function InnerError({ error }: ErrorProps) {
  if (error.message === "bubble") {
    throw new Error(error.message);
  }
  return <p data-fallback="inner">{error.message}</p>;
}
