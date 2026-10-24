# create-furin

Official scaffolder for [Furin](https://github.com/Teyik0/furin) — the React meta-framework built on Elysia + Bun.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.4.0

---

## Usage

### Via `bun create`

```bash
bun create furin@latest my-app
```

### Via `bunx`

```bash
bunx create-furin@latest my-app
```

### Locally (development inside the monorepo)

```bash
bun apps/scaffolder/src/index.ts my-app
```

---

## Options

```text
Usage:
  bun create furin@latest <dir>
  bun create furin@latest <dir> --template <simple|full>

Options:
  -t, --template <simple|full>   Template choice (default: prompted); --template=<id> also works
  -y, --yes                      Skip interactive confirmations (requires <dir>)
  --no-install                   Do not run bun install after scaffolding
  -v, --version                  Show the create-furin package version
  -h, --help                     Show help
```

### Examples

```bash
# Full interactive mode
bun create furin@latest my-app

# Scaffold directly, no prompts
bun create furin@latest my-app --template full --yes

# Scaffold without installing dependencies
bun create furin@latest my-app --no-install
```

---

## Templates

### `simple` — Tailwind CSS + API route

```text
my-app/
├── package.json
├── tsconfig.json
├── bunfig.toml
├── furin.config.ts
├── furin-env.d.ts
├── biome.jsonc
├── README.md
├── .gitignore
├── public/
│   └── favicon.ico
└── src/
    ├── server.ts
    ├── api/
    │   └── hello.ts
    └── pages/
        ├── globals.css
        ├── root.tsx
        └── index.tsx
```

Dependencies: `@teyik0/furin`, `elysia`, `evlog`, `typebox`, `exact-mirror`, `react`, `react-dom`, `bun-plugin-tailwind`

Dev dependencies: `tailwindcss`, `typescript`, `@types/bun`, `@types/react`, `@types/react-dom`, `@biomejs/biome`, `ultracite`

---

### `full` — shadcn/ui + Tailwind CSS + API routes

```text
my-app/
├── package.json
├── tsconfig.json           ← path alias @/* → src/*
├── bunfig.toml
├── furin.config.ts
├── furin-env.d.ts
├── biome.jsonc
├── README.md
├── components.json         ← shadcn/ui config
├── .gitignore
├── public/
│   └── favicon.ico
└── src/
    ├── server.ts
    ├── api/
    │   └── hello.ts
    ├── lib/
    │   └── utils.ts        ← cn() helper (clsx + tailwind-merge)
    ├── components/
    │   └── ui/
    │       ├── button.tsx
    │       ├── card.tsx
    │       └── input.tsx
    └── pages/
        ├── globals.css     ← CSS oklch variables (light + dark theme)
        ├── root.tsx
        └── index.tsx
```

Dependencies: everything in `simple`, plus `class-variance-authority`, `clsx`, `tailwind-merge`, `@radix-ui/react-slot`, `lucide-react`, `tw-animate-css`. Dev dependencies: same as `simple`.

---

## After scaffolding

The scaffolder automatically runs:

1. **`bun install`** — installs all dependencies (skipped with `--no-install`)
2. **`git init`** + first commit `chore: initial scaffold` (the commit is skipped when git has no `user.name`/`user.email`)

To get started:

```bash
cd my-app
bun dev            # http://localhost:3000
bun run tscheck    # TypeScript check
bun run build      # self-contained executable in .furin/build/bun/
bun run start      # run the built executable
```

---

## Scaffolder development

```bash
# Tests
bun run --filter="create-furin" test

# TypeScript check
bun run --filter="create-furin" tscheck
```

`create-furin` is versioned independently from the core library. `--version` reports
the scaffolder's own manifest version; generated projects resolve the published
core separately. Publishing a `create-furin-v<version>` GitHub release runs a
packed-package smoke test before publication:

```bash
FURIN_SCAFFOLDER_RELEASE_SMOKE=1 bun test apps/scaffolder/tests/package.test.ts
```

This test accesses the public registry, installs the archive in an isolated
consumer, reinstalls with its frozen lockfile, and builds and type-checks the
generated simple and full starters. Ordinary workspace tests skip this network-dependent
release check.

### Updating a dependency version

Edit `src/generated/package-catalog.json` — templates automatically pick up new versions on the next scaffold:

```json
{
  "elysia": "2.0.0-beta.32",
  "react": "^19.3.1"
}
```

`@teyik0/furin` is resolved from npm at scaffold time. When the registry is unreachable, the scaffolder falls back to the version in `packages/core/package.json`, which `bun build` inlines into `dist/`.

### Adding a template

1. Create the `templates/<id>/` folder with the desired files
2. Add the entry to `templates/manifest.json` (schema v2)
3. Use `kind: "package-json"` for generated `package.json`, `kind: "ejs"` for rendered templates, and `kind: "static"` for byte-for-byte copies
