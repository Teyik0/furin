import { defineRoute } from "@teyik0/furin";
import { useState } from "react";

export const route = defineRoute("/(outer)/(inner)/detail/_route")
  .config({ mode: "ssr" })
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
