import type { ErrorProps } from "@teyik0/furin";

export default function AdminError({ error }: ErrorProps) {
  return <p>Admin error: {error.message}</p>;
}
