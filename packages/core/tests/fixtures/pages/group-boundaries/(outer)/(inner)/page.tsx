import { defineRoute, notFound } from "@teyik0/furin";
import { t } from "elysia";
import { useState } from "react";
import { route as rootRoute } from "../../root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr", query: t.Object({ failure: t.String() }) })
  .page(({ query }) => {
    const [failed, setFailed] = useState(false);
    if (failed) {
      if (query.failure === "not-found") {
        notFound({ message: "missing page" });
      }
      throw new Error(query.failure);
    }
    return (
      <button onClick={() => setFailed(true)} type="button">
        Fail page
      </button>
    );
  });
