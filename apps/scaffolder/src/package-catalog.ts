import catalog from "./generated/package-catalog.json";

export interface PackageCatalog {
  "@teyik0/furin": string;
  "@types/bun": string;
  "@types/react": string;
  "@types/react-dom": string;
  "bun-plugin-tailwind": string;
  "class-variance-authority": string;
  clsx: string;
  elysia: string;
  evlog: string;
  "lucide-react": string;
  "radix-ui": string;
  react: string;
  "react-dom": string;
  "tailwind-merge": string;
  tailwindcss: string;
  "tw-animate-css": string;
  typescript: string;
}

export function getPackageCatalog(): PackageCatalog {
  return catalog as PackageCatalog;
}
