<div align="center">
  <img src="https://raw.githubusercontent.com/teyik0/furin/main/apps/docs/public/furin-logo.webp" alt="Furin" width="120" />
  <h1>Furin</h1>
  <p>React meta-framework powered by Elysia and Bun — file-based routing, SSR, SSG, ISR, and full TypeScript inference.</p>

  <a href="https://www.npmjs.com/package/@teyik0/furin"><img src="https://img.shields.io/npm/v/%40teyik0%2Ffurin?style=flat-square&logo=npm&color=orange" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@teyik0/furin"><img src="https://img.shields.io/npm/dm/%40teyik0%2Ffurin?style=flat-square&color=orange" alt="npm downloads" /></a>
  <a href="https://github.com/teyik0/furin/blob/main/LICENSE"><img src="https://img.shields.io/github/license/teyik0/furin?style=flat-square" alt="License" /></a>
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

## Replayable mutations

Install `furinSync(sync)` on an Elysia API plugin to make mutations idempotent and replayable by default, and pass the same explicit runtime to `furin({ sync })`. Send an `Idempotency-Key` on every mutation handled by `furinSync()`; routes using `idempotent: false` or `furinInvalidate()` without `furinSync()` do not require one. Use `idempotent: false` for payments, uploads, streams, and other non-replayable effects: their invalidations still apply and broadcast. SQLite `:memory:` is available for development and tests but rejected in production. Use file-backed SQLite for one host, or PostgreSQL/Redis for multi-host replicas. Adapters ship as isolated `@teyik0/furin/sync/*` subpaths.
