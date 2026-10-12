import { defineRootRoute } from "@teyik0/furin";
import { Shell } from "../ui/shell";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => <Shell>{children}</Shell>);
