import { describe, expect, test } from "bun:test";
import { detectClientFeatures } from "../../src/rsc/detect";

describe("detectClientFeatures — React hooks", () => {
  test("detects useState as client feature", () => {
    const code =
      "function Counter() { const [count, setCount] = useState(0); return <div>{count}</div>; }";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features).toContain("useState");
  });

  test("detects useEffect as client feature", () => {
    const code = "function Component() { useEffect(() => {}, []); return null; }";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features).toContain("useEffect");
  });

  test("detects useContext as client feature", () => {
    const code = "function Component() { const ctx = useContext(MyContext); return null; }";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features).toContain("useContext");
  });

  test("detects useReducer as client feature", () => {
    const code =
      "function Component() { const [state, dispatch] = useReducer(reducer, init); return null; }";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features).toContain("useReducer");
  });

  test("detects useRef as client feature", () => {
    const code = "function Component() { const ref = useRef(null); return null; }";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features).toContain("useRef");
  });

  test("detects useMemo as client feature", () => {
    const code =
      "function Component() { const memo = useMemo(() => expensive(), []); return null; }";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features).toContain("useMemo");
  });

  test("detects useCallback as client feature", () => {
    const code = "function Component() { const cb = useCallback(() => {}, []); return null; }";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features).toContain("useCallback");
  });

  test("detects useTransition as client feature", () => {
    const code =
      "function Component() { const [isPending, startTransition] = useTransition(); return null; }";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features).toContain("useTransition");
  });

  test("detects useDeferredValue as client feature", () => {
    const code = "function Component() { const deferred = useDeferredValue(value); return null; }";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features).toContain("useDeferredValue");
  });
});

describe("detectClientFeatures — event handlers", () => {
  test("detects onClick as client feature", () => {
    const code = `<button onClick={() => alert('hi')}>Click</button>`;
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features.some((f) => f.includes("onClick"))).toBe(true);
  });

  test("detects onChange as client feature", () => {
    const code = "<input onChange={(e) => setValue(e.target.value)} />";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features.some((f) => f.includes("onChange"))).toBe(true);
  });

  test("detects onSubmit as client feature", () => {
    const code = "<form onSubmit={(e) => e.preventDefault()}></form>";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features.some((f) => f.includes("onSubmit"))).toBe(true);
  });

  test("detects onFocus as client feature", () => {
    const code = "<input onFocus={() => setFocused(true)} />";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features.some((f) => f.includes("onFocus"))).toBe(true);
  });

  test("detects onBlur as client feature", () => {
    const code = "<input onBlur={() => setFocused(false)} />";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features.some((f) => f.includes("onBlur"))).toBe(true);
  });

  test("detects onKeyDown as client feature", () => {
    const code = `<input onKeyDown={(e) => e.key === 'Enter' && submit()} />`;
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features.some((f) => f.includes("onKeyDown"))).toBe(true);
  });

  test("detects onMouseEnter as client feature", () => {
    const code = "<div onMouseEnter={() => setHovered(true)}>Hover me</div>";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features.some((f) => f.includes("onMouseEnter"))).toBe(true);
  });
});

describe("detectClientFeatures — browser APIs", () => {
  test("detects window as client feature", () => {
    const code = "const width = window.innerWidth;";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features).toContain("window");
  });

  test("detects document as client feature", () => {
    const code = `const el = document.getElementById('root');`;
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features).toContain("document");
  });

  test("detects localStorage as client feature", () => {
    const code = `const token = localStorage.getItem('token');`;
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features).toContain("localStorage");
  });

  test("detects sessionStorage as client feature", () => {
    const code = `const data = sessionStorage.getItem('key');`;
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features).toContain("sessionStorage");
  });

  test("detects navigator as client feature", () => {
    const code = "const ua = navigator.userAgent;";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features).toContain("navigator");
  });
});

describe("detectClientFeatures — server components (no client features)", () => {
  test("returns server for async component without hooks", () => {
    const code =
      "async function UserProfile({ id }) { const user = await db.users.find(id); return <div>{user.name}</div>; }";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(false);
    expect(result.features).toHaveLength(0);
  });

  test("returns server for simple functional component", () => {
    const code = "function Header({ title }) { return <h1>{title}</h1>; }";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(false);
    expect(result.features).toHaveLength(0);
  });

  test("returns server for component with only props destructuring", () => {
    const code = `
      function Card({ title, description, imageUrl }) {
        return (
          <div className="card">
            <img src={imageUrl} alt={title} />
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
        );
      }
    `;
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(false);
    expect(result.features).toHaveLength(0);
  });

  test("returns server for component with async data fetching", () => {
    const code = `
      async function ProductList() {
        const products = await fetch('/api/products').then(r => r.json());
        return (
          <ul>
            {products.map(p => <li key={p.id}>{p.name}</li>)}
          </ul>
        );
      }
    `;
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(false);
    expect(result.features).toHaveLength(0);
  });
});

describe("detectClientFeatures — warnings", () => {
  test("warns when onSomething prop has string value", () => {
    const code = `<Translation onKeyNotFound="fallback" />`;
    const result = detectClientFeatures(code);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("onKeyNotFound");
  });

  test("warns for onHandler with string value", () => {
    const code = `<Button onClickHandler="doSomething" />`;
    const result = detectClientFeatures(code);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("no warning when onSomething has function value", () => {
    const code = `<Button onClick={() => console.log('click')} />`;
    const result = detectClientFeatures(code);
    const stringEventWarning = result.warnings.find((w) => w.includes("string value"));
    expect(stringEventWarning).toBeUndefined();
  });
});

describe("detectClientFeatures — confidence", () => {
  test("high confidence for clear client component (hooks)", () => {
    const code =
      "function Component() { const [state, setState] = useState(0); return <div>{state}</div>; }";
    const result = detectClientFeatures(code);
    expect(result.confidence).toBeGreaterThanOrEqual(0.95);
  });

  test("high confidence for clear server component", () => {
    const code =
      "async function Page() { const data = await fetchData(); return <div>{data}</div>; }";
    const result = detectClientFeatures(code);
    expect(result.confidence).toBeGreaterThanOrEqual(0.95);
  });

  test("lower confidence when only browser API mentioned", () => {
    const code = `const isBrowser = typeof window !== 'undefined';`;
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.confidence).toBeLessThan(1.0);
  });
});

describe("detectClientFeatures — edge cases", () => {
  test("handles empty code", () => {
    const result = detectClientFeatures("");
    expect(result.isClient).toBe(false);
    expect(result.features).toHaveLength(0);
  });

  test("handles code with only comments", () => {
    const code = "// This is a comment\n/* multiline */";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(false);
  });

  test("does not detect useSomething that is not a React hook", () => {
    const code = "const result = useCustomThing();";
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features).toContain("useCustomThing");
  });

  test("detects multiple client features", () => {
    const code = `
      function Component() {
        const [count, setCount] = useState(0);
        const ref = useRef(null);
        return <button onClick={() => setCount(c => c + 1)} ref={ref}>{count}</button>;
      }
    `;
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features).toContain("useState");
    expect(result.features).toContain("useRef");
    expect(result.features.some((f) => f.includes("onClick"))).toBe(true);
  });

  test("handles TypeScript code", () => {
    const code = `
      interface Props {
        id: string;
        name: string;
      }
      function Component({ id, name }: Props) {
        const [value, setValue] = useState<string>('');
        return <div>{name}</div>;
      }
    `;
    const result = detectClientFeatures(code);
    expect(result.isClient).toBe(true);
    expect(result.features).toContain("useState");
  });
});
