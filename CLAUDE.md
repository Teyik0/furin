# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Furin** is a React meta-framework powered by [Elysia](https://elysiajs.com/). It provides file-based routing with SSR, SSG, and ISR rendering modes, nested layouts, HMR with React Fast Refresh, and full TypeScript type inference — similar to Tanstack Start but built on Elysia + Bun.

## Commands

- `bun run dev` — Run the example app with HMR
- `bun run fix` — Auto-fix lint issues
- `bun run test` — Run tests
- `bun run build` — Build the library to `dist/`
- `bun run test:types` — Type-check without emitting

## Tooling

- **Runtime**: Bun only. Never use Node.js, npm, yarn, pnpm, dotenv, express, vite, or webpack.
- **Linting**: Ultracite (wraps Biome). Config in `biome.jsonc`.
- **CSS**: Tailwind v4 via `bun-plugin-tailwind` (configured in `bunfig.toml`).
- **Path alias**: `"furin"` maps to `./packages/core/src/furin.ts` (see `tsconfig.json` paths).

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

## Coding best practices

### Plan mode

- Always show architecture decision with alternative
- Always show the code you want to implement when architecture is validated
- Always give recommendation regarding the best approach
- Always propose to eliminate / rebuild from scratch code that you think not enought flexible to integrate the new feature
- Always rethink architecture and pattern to make the best maintainable choice
- Always check how is the competitor doing, compare and give the best answer
- Always load TDD skill from Matt Pocock

### Build mode

- Avoid default values for function parameter
- Avoid null | undefined for function parameter, they should exist (i.e string | undefined)
- Always run bun fix && bun run test && bun run test:types when work is done
- Always run git hook when commiting or pushing to github
- Always fix any lint, type and tests error

### When features is done

- Typecheck new code
- Run fix command to check any lint issues
- Rebuild every workspace
- Run tests
