import { expect, test } from "bun:test";
import { backendInputPath } from "../src/cli";

test.each(["C:/Users/app/server.ts", "/C:/Users/app/server.ts", "../../C:/Users/app/server.ts"])(
  "dependency scans retain the drive of cross-drive metafile input %s",
  (path) => {
    expect(backendInputPath("D:/checkout", path)).toBe(String.raw`C:\Users\app\server.ts`);
  }
);

test("dependency scans resolve ordinary inputs relative to the compiler working directory", () => {
  expect(backendInputPath(String.raw`D:\checkout`, String.raw`..\..\C:\Users\app\server.ts`)).toBe(
    String.raw`C:\Users\app\server.ts`
  );
  expect(backendInputPath("D:/checkout", "src/server.ts")).toBe(
    String.raw`D:\checkout\src\server.ts`
  );
  expect(backendInputPath("/checkout", "../app/server.ts")).toBe("/app/server.ts");
});
