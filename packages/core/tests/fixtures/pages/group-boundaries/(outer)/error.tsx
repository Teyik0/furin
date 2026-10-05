import type { ErrorProps } from "@teyik0/furin";

export default function OuterError({ error }: ErrorProps) {
  return <p data-fallback="outer">{error.message}</p>;
}
