import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fromCrossJSON, toCrossJSON } from "seroval";
import "../../setup/evlog-mock";

import { FurinErrorBoundary } from "../../../src/client/boundaries.tsx";
import { serializeDeferredRejection } from "../../../src/server/render/loaders.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { computeErrorDigest } from "../../../src/shared/digest.ts";
import { isNotFoundError, notFound } from "../../../src/shared/not-found.ts";

async function roundtrip(value: unknown): Promise<unknown> {
  const normalized = await serializeDeferredRejection(value);
  const chunk = toCrossJSON(normalized);
  return fromCrossJSON(chunk, {});
}

describe("serializeDeferredRejection — preserves rejection semantics over CrossJSON", () => {
  let previousDevMode: boolean;
  beforeEach(() => {
    previousDevMode = IS_DEV;
    __setDevMode(true);
  });
  afterEach(() => __setDevMode(previousDevMode));
  test("notFound(): brand preserved so isNotFoundError() is true on the client", async () => {
    let thrown: unknown;
    try {
      notFound({ data: { id: "x" }, message: "missing" });
    } catch (e) {
      thrown = e;
    }

    const result = await roundtrip(thrown);

    expect(isNotFoundError(result)).toBe(true);
    expect((result as Error).message).toBe("missing");
    expect((result as { data?: { id?: string } }).data).toEqual({ id: "x" });
  });

  test("notFound() without options: brand preserved, empty message", async () => {
    let thrown: unknown;
    try {
      notFound(undefined);
    } catch (e) {
      thrown = e;
    }

    const result = await roundtrip(thrown);

    expect(isNotFoundError(result)).toBe(true);
  });

  test("Response(403, body): status and message preserved", async () => {
    const response = new Response("forbidden", { status: 403, statusText: "Forbidden" });

    const result = await roundtrip(response);

    expect((result as Error).message).toBe("forbidden");
    expect((result as { __furinStatus?: number }).__furinStatus).toBe(403);
    expect(isNotFoundError(result)).toBe(false);
  });

  test("Response without body: uses statusText", async () => {
    const response = new Response(null, { status: 401, statusText: "Unauthorized" });

    const result = await roundtrip(response);

    expect((result as Error).message).toBe("Unauthorized");
    expect((result as { __furinStatus?: number }).__furinStatus).toBe(401);
  });

  test("standard Error: message preserved as-is", async () => {
    const err = new Error("boom");

    const result = await roundtrip(err);

    expect((result as Error).message).toBe("boom");
    expect(isNotFoundError(result)).toBe(false);
  });

  test("throw non-Error (string): wrapped in Error", async () => {
    const result = await roundtrip("oops");

    expect((result as Error).message).toBe("oops");
  });

  test("production rejection omits internal messages and stacks", async () => {
    const originalDevMode = IS_DEV;
    __setDevMode(false);
    try {
      const secret = new Error("database-password=secret");
      secret.stack = "database-password=secret\n at /private/server.ts:1:1";

      const normalized = await serializeDeferredRejection(secret);
      const chunk = toCrossJSON(normalized);
      const wire = JSON.stringify(chunk);
      const result = fromCrossJSON(chunk, {});

      expect((result as Error).message).toBe("An unexpected error occurred.");
      expect((result as Error).stack).not.toContain("database-password");
      expect((result as Error).stack).not.toContain("/private/server.ts");
      expect((result as { __furinDigest?: string }).__furinDigest).toHaveLength(10);
      expect(wire).not.toContain("database-password");
      expect(wire).not.toContain("/private/server.ts");
      expect(wire).not.toContain("loaders.ts");
      expect(wire).not.toContain("sourceURL");
    } finally {
      __setDevMode(originalDevMode);
    }
  });

  test("production rejection keeps its server digest in a parent error boundary", async () => {
    const originalDevMode = IS_DEV;
    __setDevMode(false);
    try {
      const serverError = new Error("database-password=secret");
      serverError.stack = "database-password=secret\n at /private/server.ts:1:1";
      const serverDigest = computeErrorDigest(serverError);
      const clientError = (await roundtrip(serverError)) as Error;
      const boundary = new FurinErrorBoundary({
        children: null,
        fallback: ({ error }) => createElement("span", null, error.digest),
      });
      const derived = FurinErrorBoundary.getDerivedStateFromError(clientError);
      boundary.state = { ...boundary.state, ...derived } as typeof boundary.state;

      const html = renderToStaticMarkup(boundary.render());

      expect(computeErrorDigest(clientError)).not.toBe(serverDigest);
      expect(html).toContain(serverDigest);
    } finally {
      __setDevMode(originalDevMode);
    }
  });
});
