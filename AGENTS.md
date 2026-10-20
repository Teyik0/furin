As an agent, you should help the user develop senior-grade features, as such you need to follow some guidance:

- Always load TDD skill from Matt Pocock
- Always show architecture decision with alternative
- Always give recommendation regarding the best approach
- Always propose to eliminate / rebuild from scratch code that you think not flexible enough to integrate the new feature
- Always rethink architecture and patterns to make the most maintainable choice
- Always check how competitors are doing (Next.js, TanStack Start), compare approaches, and recommend the best solution
- Always check existing documentation around library we are using
- Avoid default values for function parameters
- Always run git hooks when committing or pushing to GitHub
- Avoid usage of Record<string, unknown> as it does not represent correctly the types, always prefer strict types if possible
- Always think before coding. Don't assume. Don't hide confusion. Surface tradeoffs.
- Before implementing, always state your assumptions explicitly. If uncertain, ask. If multiple interpretations exist, present them, don't pick silently. If a simpler approach exists, say so. Push back when warranted. If something is unclear, stop. Name what's confusing. Ask.
- Always produce the minimum code that solves the problem. Nothing speculative. No features beyond what was asked. No abstractions for single-use code. No "flexibility" or "configurability" that wasn't requested. No error handling for impossible scenarios. If you write 200 lines and it could be 50, rewrite it. Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.
- Always produce surgical changes. Touch only what you must. Clean up only your own mess when editing existing code. Don't "improve" adjacent code, comments, or formatting. Don't refactor things that aren't broken. Match existing style, even if you'd do it differently. If you notice unrelated dead code, mention it - don't delete it.

## Project Overview

**Furin** is a React meta-framework powered by [Elysia](https://elysiajs.com/). It provides file-based routing with SSR, SSG, and ISR rendering modes, nested layouts, HMR with React Fast Refresh, and full TypeScript type inference, similar to Tanstack Start but built on Elysia + Bun.

## Commands

- `bun run dev` — Run the example app with HMR
- `bun run fix` — Auto-fix lint issues
- `bun run test` — Run tests
- `bun run build` — Build the library to `dist/`
- `bun run start` — Run all workspace apps that define a production `start` script
- `bun run tscheck` — Type-check without emitting

## Tooling

- **Runtime**: Bun only. Never use Node.js, npm, yarn, pnpm, dotenv, express, vite, or webpack.
- **Linting**: Ultracite (wraps Biome). Config in `biome.jsonc`.
- **CSS**: Tailwind v4 via `bun-plugin-tailwind` (configured in `bunfig.toml`).
- **Path alias**: `"furin"` maps to `./packages/core/src/furin.ts` (see `packages/core/tsconfig.json` paths).

## HMR

**Leverage Bun**: In dev-mode we use bun HMR and a bun plugin to make HMR fast and efficient. No vite, 1 process, backend and frontend at the same place.
The user can then use this plugin in this project as such:

```toml
# in bunfig.toml
[serve.static]
plugins = ["bun-plugin-tailwind", "furin/strip-plugin"]
env = "FURIN_PUBLIC_*"
```

And for the production build

```ts
// in furin.config.ts
import tailwind from "bun-plugin-tailwind";
import { defineConfig } from "furin/config";

export default defineConfig({
  plugins: [tailwind],
});
```

## DX

- **./packages/core/src/client.ts**: The whole typesafe DX lie in this file.
- **./packages/core/src/furin.ts**: Main lib export, your frontend served as an Elysia plugin. WinterCG compliant out of the box. Serve as much Furin plugin you need with different pagesDir.

## Elysia best practices

- Always chain Elysia instances, using reduces for example.
- Elysia order instances matter.

### When features is done

- Typecheck new code
- Run fix command to check any lint issues
- Rebuild every workspace
- Run tests
