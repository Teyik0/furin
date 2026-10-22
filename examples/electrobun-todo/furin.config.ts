import { defineConfig } from "@teyik0/furin/config";
import { defineDesktopConfig } from "@teyik0/furin-electrobun";

export default defineConfig({
  desktop: defineDesktopConfig({
    app: { identifier: "local.furin.relay", name: "Relay" },
    build: { mainProcess: "bun", bun: { entrypoint: "src/desktop.ts" } },
  }),
});
