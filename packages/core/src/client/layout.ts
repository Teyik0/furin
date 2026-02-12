import type { HeadOptions } from "./shared";

export interface LayoutContext<
  TParentData extends Record<string, unknown> = Record<string, never>,
> {
  parentData: TParentData;
  params: Record<string, string>;
  query: Record<string, unknown>;
}

export interface LayoutOptions<
  TData extends Record<string, unknown>,
  TParentData extends Record<string, unknown> = Record<string, never>,
> {
  loader?: (ctx: LayoutContext<TParentData>) => Promise<TData> | TData;
  head?: (ctx: { parentData: TParentData; data: TData }) => HeadOptions;
  component: React.FC<TData & { children: React.ReactNode }>;
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number | false;
}

export function layout<
  TData extends Record<string, unknown>,
  TParentData extends Record<string, unknown> = Record<string, never>,
>(props: LayoutOptions<TData, TParentData>) {
  return {
    __brand: "ELYSION_REACT_LAYOUT",
    ...props,
  };
}

export type LayoutModule = typeof layout;

export function isLayoutModule(value: unknown): value is LayoutModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "__brand" in value &&
    (value as { __brand?: string }).__brand === "ELYSION_REACT_LAYOUT"
  );
}
