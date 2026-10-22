import { expect, test } from "bun:test";
import { getDesktopHost } from "../src/host";

test("host access outside a native launch is safe and initializes no SDK", () => {
  expect(getDesktopHost()).toBeNull();
});
