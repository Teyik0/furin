import type { ReactDoctorConfig } from "react-doctor/api";

export default {
  deadCode: false,
  ignore: {
    overrides: [
      {
        // `DocsToc` creates an IntersectionObserver from a nested registration
        // helper, but the effect-level cleanup disconnects that observer.
        files: ["src/components/docs-toc.tsx"],
        rules: ["react-doctor/effect-needs-cleanup"],
      },
      {
        // Server router handlers call `useLogger()` (an Elysia, not React,
        // hook) and render elements host hooks the rule can't statically
        // prove. Patterns are package-relative; `src/pages/**` applies to each
        // React Doctor project that has file-based pages.
        files: [
          "src/server/render/**",
          "src/server/router/**",
          "src/client/router/**",
          "src/pages/**",
        ],
        rules: ["react-doctor/rules-of-hooks"],
      },
      {
        files: [
          "src/server/router/**",
          "src/client/router/provider.tsx",
          "src/shared/deferred-ndjson.ts",
          "src/shared/utils/index.ts",
          "src/server/render/**",
          "src/build/index.ts",
          "src/adapter/bun.ts",
          "src/adapter/static.ts",
          "src/furin.ts",
        ],
        rules: [
          "react-doctor/async-await-in-loop",
          "react-doctor/async-parallel",
          "react-doctor/async-defer-await",
          "react-doctor/server-sequential-independent-await",
          "react-doctor/no-dynamic-import-path",
        ],
      },
      {
        files: [
          "src/server/render/**",
          "src/client/router/provider.tsx",
          "src/client/router/boundary-tree.tsx",
          "src/client/boundaries.tsx",
          "src/client/link.tsx",
          "src/shared/await.tsx",
        ],
        rules: ["react-doctor/only-export-components"],
      },
      {
        files: ["src/client/link.tsx", "src/shared/await.tsx"],
        rules: ["react-doctor/no-children-prop"],
      },
      {
        files: ["src/pages/**"],
        rules: ["react-doctor/no-multi-comp"],
      },
      {
        // The isolated DevTools client owns its fetch/SSE lifecycle. The effect
        // returns cleanup for its EventSource, retry timeout and refresh interval,
        // but React Doctor cannot follow the resources assigned by async connect().
        files: ["src/devtools/dashboard.tsx"],
        rules: [
          "react-doctor/effect-needs-cleanup",
          "react-doctor/no-fetch-in-effect",
          "react-doctor/no-high-complexity-react-function",
        ],
      },
      {
        // These files generate source or reconcile watcher inputs; their ordered
        // array passes are intentional and independent from React render work.
        files: ["src/build/hydrate.ts"],
        rules: ["react-doctor/js-combine-iterations", "react-doctor/js-tosorted-immutable"],
      },
      {
        files: ["src/plugin/routes.ts"],
        rules: ["react-doctor/js-combine-iterations"],
      },
      {
        files: ["src/pages/docs/*.tsx", "src/components/ui/button.tsx"],
        rules: ["react-doctor/only-export-components"],
      },
      {
        files: ["src/client/router/provider.tsx", "src/client/router/context.ts"],
        rules: [
          "react-doctor/no-giant-component",
          "react-doctor/no-react19-deprecated-apis",
          "react-doctor/prefer-use-effect-event",
          "react-doctor/js-index-maps",
          "react-doctor/exhaustive-deps",
          "react-doctor/advanced-event-handler-refs",
        ],
      },
      {
        files: ["src/client/link.tsx"],
        rules: ["react-doctor/no-event-handler"],
      },
      {
        files: ["src/server/render/**", "src/client/boundaries.tsx"],
        rules: ["react-doctor/no-did-update-set-state"],
      },
      {
        files: ["tests/**", "**/*.test.ts", "**/*.test.tsx"],
        rules: [
          "react-doctor/no-eval",
          "react-doctor/no-flush-sync",
          "react-doctor/js-set-map-lookups",
          "react-doctor/no-children-prop",
        ],
      },
    ],
  },
} satisfies ReactDoctorConfig;
