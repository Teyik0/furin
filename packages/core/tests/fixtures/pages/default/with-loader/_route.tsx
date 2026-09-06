import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .loader(({ request, headers, cookie, path, set }) => {
    set.headers["x-loader-ran"] = "true";
    return {
      cookieValue: cookie.test?.value as string | undefined,
      currentPath: path,
      hasHeaders: !!headers,
      layoutData: "from-layout",
      requestUrl: request.url,
    };
  })
  .layout(({ data: { layoutData }, children }) => (
    <div data-layout={String(layoutData)} data-testid="loader-layout">
      {children}
    </div>
  ));
