import "../../public/global.css";

import { page } from "elysion";
import { useState } from "react";

export default page(
  () => {
    const [count, setCount] = useState(0);

    return (
      <div>
        <h1>Counter example</h1>
        <span>{count}</span>
        <button onClick={() => setCount((prev) => prev + 1)} type="button">
          Increment
        </button>
      </div>
    );
  },
  { mode: "ssr" }
);
