/** Type-only access to the original Electrobun devkit. Never initializes native code. */
export type DesktopSdk = typeof import("electrobun/main");
