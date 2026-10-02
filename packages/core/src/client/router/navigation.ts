import { useRouter } from "./context.ts";
import type { Navigate } from "./types.ts";

export type { Navigate, NavigateInput } from "./types.ts";

export function useNavigate(): Navigate {
  return useRouter().navigate;
}
