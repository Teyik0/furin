import { defineRootRoute, defineRoute } from "../../src/furin.ts";

const identity = <T extends object>(value: T): T => value;
const root = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => children);

export const route = defineRoute()
  .config({ layout: root, mode: "isr", revalidate: 60 })
  .requestLoader(async () => {
    const extra = identity({ permissions: Promise.resolve(["read"]) });
    return { user: "Alice", ...extra };
  })
  .page(() => null);
