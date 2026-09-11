import { createContext, use, useCallback, useEffect, useMemo, useReducer } from "react";

export type Theme = "dark" | "light";

const ThemeContext = createContext<{
  theme: Theme;
  toggleTheme: () => void;
}>({
  theme: "dark",
  toggleTheme: () => {
    /* noop */
  },
});

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem("furin-theme") as Theme | null;
    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // localStorage unavailable (private mode, sandboxed iframe, etc.) — keep default
  }
  return "dark";
}

function themeReducer(_state: Theme, action: "toggle" | Theme): Theme {
  if (action === "toggle") {
    return _state === "dark" ? "light" : "dark";
  }
  return action;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, dispatch] = useReducer(themeReducer, "dark", readStoredTheme);

  // shadcn best practice: apply theme class on <html> so Radix portals
  // (dropdowns, dialogs, tooltips…) inherit the correct color scheme.
  // Persistence happens here too — driven by the COMMITTED `theme`, never by a
  // render-snapshot value in the click handler. Computing the next value in
  // the handler desyncs localStorage from reducer state when two toggles fire
  // before a re-render (both read the same stale `theme`).
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(theme);
    try {
      localStorage.setItem("furin-theme", theme);
    } catch {
      // localStorage unavailable (private mode, sandboxed iframe, etc.)
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    dispatch("toggle");
  }, []);

  const contextValue = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme]);

  return (
    <ThemeContext.Provider value={contextValue}>
      <div className="min-h-screen bg-background text-foreground">{children}</div>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return use(ThemeContext);
}
