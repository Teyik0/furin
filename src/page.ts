export interface PageOptions {
  loader?: () => void;
  head?: () => void;
  action?: () => void;
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number;
}

export function page(component: React.FC, options?: PageOptions): PageModule {
  return {
    __brand: "elysion-react-page",
    component,
    options,
  };
}

export interface PageModule {
  __brand: "elysion-react-page";
  component: React.FC<Record<string, unknown>>;
  options?: PageOptions;
}

export function isPageModule(value: unknown): value is PageModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "__brand" in value &&
    (value as { __brand?: string }).__brand === "elysion-react-page"
  );
}
