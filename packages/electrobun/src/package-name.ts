const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;

export function isPackageName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    PACKAGE_NAME.test(value) &&
    (value.startsWith("@") ? value.slice(1) : value)
      .split("/")
      .every((segment) => segment !== "." && segment !== "..")
  );
}
