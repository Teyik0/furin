import { createRoute } from "elysion/client";
import { useState } from "react";

const route = createRoute({ mode: "ssr" });

export default route.page({
  component: () => {
    const [count, setCount] = useState(0);

    return (
      <div>
        <h1>Blog Page</h1>
        <span>{count}</span>
        <button onClick={() => setCount((prev) => prev + 1)} type="button">
          Increment
        </button>
      </div>
    );
  },
});
