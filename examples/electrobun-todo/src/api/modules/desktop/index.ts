import { desktopContext } from "@teyik0/furin-electrobun/server";
import { Elysia, status } from "elysia";

export const desktopApi = new Elysia({ name: "relay-desktop", prefix: "/desktop" })
  .use(desktopContext)
  .get("/", ({ desktop }) => ({ available: desktop !== null }))
  .macro({
    desktopOnly: {
      derive({ desktop }) {
        if (!desktop) {
          return status(409, { error: "Desktop unavailable" });
        }
        return { desktop };
      },
    },
  })
  .guard({ desktopOnly: true })
  .post("/minimize", ({ desktop }) => {
    desktop.window?.minimize();
    return { ok: true };
  })
  .post("/open", ({ desktop }) => {
    desktop.open();
    return { ok: true };
  });
