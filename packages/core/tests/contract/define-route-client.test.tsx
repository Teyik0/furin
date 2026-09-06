import { describe, expect, test } from "bun:test";
import { defineRoute } from "../../src/client.ts";

const Page = () => "page";
const Layout = ({ children }: { children: React.ReactNode }) => children;

describe("client defineRoute", () => {
  test("keeps only the terminal component contract", () => {
    const pageRoute = defineRoute().page(Page);
    const layoutRoute = defineRoute().layout(Layout);

    expect(pageRoute.component({ message: "hello" })).toBe("page");
    expect(layoutRoute.component({ children: "layout" })).toBe("layout");
    expect(pageRoute.__type).toBe("FURIN_ROUTE");
    expect(layoutRoute.__type).toBe("FURIN_ROUTE");
    expect("elysia" in pageRoute).toBe(false);
    expect("loader" in pageRoute).toBe(false);
  });

  test("keeps request data outside public loader data", () => {
    let received: unknown;
    const pageRoute = defineRoute().page((props) => {
      received = props;
      return null;
    });

    pageRoute.component({
      message: "public",
      requestData: Promise.resolve({ sessionId: "private" }),
    });

    expect(received).toEqual({
      children: undefined,
      data: { message: "public" },
      params: {},
      path: "",
      query: {},
      requestData: expect.any(Promise),
    });
  });
});
