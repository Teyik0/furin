<div align="center">
  <img src="apps/docs/public/furin-logo.webp" alt="Furin" width="120" />
  <h1>Furin</h1>
  <p>React meta-framework powered by Elysia and Bun — file-based routing, SSR, SSG, ISR, and full TypeScript inference.</p>

  <a href="https://www.npmjs.com/package/@teyik0/furin"><img src="https://img.shields.io/npm/v/%40teyik0%2Ffurin?style=flat-square&logo=npm&color=orange" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@teyik0/furin"><img src="https://img.shields.io/npm/dm/%40teyik0%2Ffurin?style=flat-square&color=orange" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/teyik0/furin?style=flat-square" alt="License" /></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/bun-%3E%3D1.4.0-f5d147?style=flat-square&logo=bun&logoColor=black" alt="Bun" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
</div>

---

## Quick Start

```bash
bun create furin@latest my-app
cd my-app
bun install
bun run dev
```

For the shadcn/ui starter:

```bash
bun create furin@latest my-app --template full
```

## Documentation

Full API reference, rendering modes, routing, and deployment guides at **[teyik0.github.io/furin](https://teyik0.github.io/furin/)**.

## Monorepo

| Workspace | Description |
|---|---|
| [`packages/core`](packages/core) | Core library — `@teyik0/furin` |
| [`apps/docs`](apps/docs) | Documentation site |
| [`examples/task-manager`](examples/task-manager) | Example: task manager app |
| [`examples/weather`](examples/weather) | Example: weather app |
| [`packages/electrobun`](packages/electrobun) | Optional Electrobun desktop integration — `@teyik0/furin-electrobun` |
| [`examples/electrobun-todo`](examples/electrobun-todo) | Example: Relay todo app with the same web and Electrobun UI |

## Workspace Commands

```bash
bun run fix       # lint & format
bun run test      # run all tests
bun run tscheck   # type-check
bun run build     # build all packages
```
