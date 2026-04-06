import { treaty } from "@elysiajs/eden";
import type { Api } from "@/api";

// `window` is only available in the browser — evaluated lazily so the server
// bundle can import this file without crashing at startup.
const getOrigin = () =>
  typeof window === "undefined" ? "http://localhost:3002" : window.location.origin;

export const apiClient = treaty<Api>(getOrigin());
