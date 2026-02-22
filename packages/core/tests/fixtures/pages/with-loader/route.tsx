import { createRoute } from "../../../../src/client";
import { route as rootRoute } from "../root";

export const route = createRoute({
  parent: rootRoute,
  loader: ({ request, headers, cookie, path, set }) => {
    set.headers["x-loader-ran"] = "true";
    return {
      layoutData: "from-layout",
      requestUrl: request.url,
      hasHeaders: !!headers,
      cookieValue: cookie.test?.value as string | undefined,
      currentPath: path,
    };
  },
  layout: ({ children, layoutData }) => (
    <div data-layout={String(layoutData)} data-testid="loader-layout">
      {children}
    </div>
  ),
});
