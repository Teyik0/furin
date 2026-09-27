import { useCallback } from "react";
import {
  findSearchDefaultsForRouteTarget,
  type SearchParamsInput,
} from "../../shared/search-params.ts";
import { useRouter } from "./context.ts";
import { applyLinkParams, buildHref, navigationHrefPolicy } from "./link-utils.ts";
import type { RouteManifest, RouteParamsOf, RouteSearch } from "./types.ts";

type NavigateTo = keyof RouteManifest extends never
  ? string
  : keyof RouteManifest | `https://${string}` | `http://${string}`;

type PathParamKeys<Path extends string> = Path extends `${infer Segment}/${infer Rest}`
  ? PathParamKeys<Segment> | PathParamKeys<Rest>
  : Path extends `:${infer Key}`
    ? Key
    : Path extends "*"
      ? "*"
      : never;

type NavigateParams<To extends NavigateTo> = keyof RouteManifest extends never
  ? { params?: RouteParamsOf<To> }
  : RouteParamsOf<To> extends undefined
    ? { params?: never }
    : {
        params: RouteParamsOf<To> &
          Required<Pick<RouteParamsOf<To>, Extract<PathParamKeys<To>, keyof RouteParamsOf<To>>>>;
      };

export type NavigateInput<To extends NavigateTo> = {
  hash?: string;
  replace?: boolean;
  resetScroll?: boolean;
  search?: RouteSearch<NoInfer<To>>;
  to: To;
} & NavigateParams<NoInfer<To>>;

export type Navigate = <To extends NavigateTo>(next: NavigateInput<To>) => Promise<void>;
type NavigateOptions = Parameters<ReturnType<typeof useRouter>["navigate"]>[1];

export function useNavigate(): Navigate {
  const router = useRouter();

  return useCallback<Navigate>(
    (next) => {
      const resolvedTo = applyLinkParams(
        next.to as string,
        next.params as Record<string, string | number> | null | undefined
      );
      const searchDefaults = findSearchDefaultsForRouteTarget(resolvedTo, router.searchRoutes);
      const href = buildHref(
        resolvedTo,
        next.search as SearchParamsInput | null | undefined,
        next.hash,
        searchDefaults
      );
      const policy = navigationHrefPolicy(
        href,
        typeof window === "undefined" ? undefined : window.location.origin
      );
      if (policy === "blocked") {
        return Promise.reject(new Error("[furin] Unsafe navigation URL."));
      }
      if (policy === "external" && typeof window !== "undefined") {
        window.location.assign(href);
        return Promise.resolve();
      }
      const opts: NavigateOptions =
        next.replace === undefined && next.resetScroll === undefined
          ? undefined
          : { replace: next.replace, resetScroll: next.resetScroll };
      return router.navigate(href, opts);
    },
    [router]
  );
}
