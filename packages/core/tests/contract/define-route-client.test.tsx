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

  test("passes the flat runtime context to a page without copying it", () => {
    let received: unknown;
    const pageRoute = defineRoute().page((props) => {
      received = props;
      return null;
    });
    const renderContext = {
      message: "public",
      params: {},
      path: "/messages",
      query: {},
      requestData: Promise.resolve({ sessionId: "private" }),
    };

    pageRoute.component(renderContext);

    expect(received).toBe(renderContext);
  });

  test("passes the flat runtime context to a layout without copying it", () => {
    let received: unknown;
    const layoutRoute = defineRoute().layout((props) => {
      received = props;
      return null;
    });
    const renderContext = {
      children: "Content",
      params: {},
      path: "/messages",
      query: {},
    };

    layoutRoute.component(renderContext);

    expect(received).toBe(renderContext);
  });
});
