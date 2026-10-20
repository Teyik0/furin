import { vercel } from "@teyik0/furin/adapters/vercel";
import { defineConfig } from "@teyik0/furin/config";
import tailwind from "bun-plugin-tailwind";

export default defineConfig({
  plugins: [{ ...tailwind, buildOnly: true }],
  targets: ["bun", vercel({ regions: ["cdg1"] })],
});
