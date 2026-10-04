import { defineRoute } from "@teyik0/furin";
import { useState } from "react";
import { route as rootRoute } from "../../../root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .layout(({ children }) => {
    const [failed, setFailed] = useState(false);
    if (failed) {
      throw new Error("layout failed");
    }
    return (
      <section data-layout="detail">
        <button onClick={() => setFailed(true)} type="button">
          Fail layout
        </button>
        {children}
      </section>
    );
  });
