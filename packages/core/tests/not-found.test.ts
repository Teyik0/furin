import { describe, expect, test } from "bun:test";
import { isNotFoundError, notFound } from "../src/not-found";

describe("notFound()", () => {
  test("throws an error identifiable via isNotFoundError", () => {
    expect(() => notFound()).toThrow();

    try {
      notFound();
    } catch (err) {
      expect(isNotFoundError(err)).toBe(true);
      return;
    }

    throw new Error("notFound() did not throw");
  });

  test("propagates message and data when passed options", () => {
    try {
      notFound({ message: "Post gone", data: { slug: "missing" } });
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw new Error("expected a not-found error");
      }
      expect(err.message).toBe("Post gone");
      expect(err.data).toEqual({ slug: "missing" });
      return;
    }

    throw new Error("notFound() did not throw");
  });
});
