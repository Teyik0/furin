import { page } from "elysion";
import { useState } from "react";

import "../../public/global.css";

export default page(App, {});

export function App() {
  const [count, setCount] = useState(0);
  const increase = () => setCount((c) => c + 1);

  return (
    <main>
      <h2>{count}</h2>
      <button onClick={increase} type="button">
        Increase
      </button>
    </main>
  );
}
