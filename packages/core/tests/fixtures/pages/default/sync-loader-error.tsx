import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/sync-loader-error")
  .config({ mode: "ssr" })
  .loader(() => {
    throw new Error("synchronous loader failure");
  })
  .page(() => <div>unreachable</div>);
