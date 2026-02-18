import "../../public/global.css";

import { createRoute } from "elysion/client";
import { useState } from "react";

const { page } = createRoute({ mode: "ssg" });

export default page({
  head: () => ({ meta: [{ title: "HMR Test" }] }),
  component: () => {
    const [count, setCount] = useState(0);

    return (
      <div className="flex items-center justify-center">
        <h1 className="font-bold text-2xl text-blue-600">Counter V2</h1>
        <span className="ml-4 text-xl">{count}</span>
        <button
          className="ml-4 rounded bg-blue-500 px-4 py-2 text-white"
          onClick={() => setCount((prev) => prev + 1)}
          type="button"
        >
          Increment
        </button>
      </div>
    );
  },
});
