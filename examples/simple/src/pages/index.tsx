import "../../public/global.css";

import { createRoute } from "elysion/client";
import { useState } from "react";

const { page } = createRoute({ mode: "ssg" });

export default page({
  head: () => ({ meta: [{ title: "ggpzzge" }] }),
  component: () => {
    const [count, setCount] = useState(0);

    return (
      <div className="flex items-center justify-center">
        <h1 className="font-bold">Counter example</h1>
        <span>{count}</span>
        <button
          className="bg-red px-4 py-2"
          onClick={() => setCount((prev) => prev + 1)}
          type="button"
        >
          Increment
        </button>
      </div>
    );
  },
});
