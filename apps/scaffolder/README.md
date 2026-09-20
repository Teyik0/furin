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
  --template <simple|full>   Template choice (default: interactive)
  --yes                      Skip interactive confirmations
  --no-install               Do not run bun install after scaffolding
  --version                  Show the targeted @teyik0/furin version
  --help                     Show help
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

Dependencies: `@teyik0/furin`, `elysia`, `evlog`, `typebox`, `exact-mirror`, `react`, `react-dom`, `bun-plugin-tailwind`, `tailwindcss`

---

### `full` — shadcn/ui + Tailwind CSS + API routes

```text
my-app/
├── package.json
├── tsconfig.json           ← path alias @/* → src/*
├── bunfig.toml
├── furin.config.ts
├── furin-env.d.ts
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

Dependencies: everything in `simple`, plus `class-variance-authority`, `clsx`, `tailwind-merge`, `@radix-ui/react-slot`, `lucide-react`, `tw-animate-css`

---

## After scaffolding

The scaffolder automatically runs:

1. **`bun install`** — installs all dependencies
2. **`git init`** + first commit `chore: initial scaffold`

To get started:

```bash
cd my-app
bun dev        # http://localhost:3000
bun tscheck    # TypeScript check
```

---

## Scaffolder development

```bash
# Tests (53 cases)
bun run --filter="create-furin" test

# TypeScript check
bun run --filter="create-furin" tscheck
```

### Updating a dependency version

Edit `src/generated/package-catalog.json` — templates automatically pick up new versions on the next scaffold:

```json
{
  "@teyik0/furin": "0.1.0-alpha.4",
  "elysia": "2.0.0-beta.16",
  "react": "^19.2.4"
}
```

### Adding a template

1. Create the `templates/<id>/` folder with the desired files
2. Add the entry to `templates/manifest.json` (schema v2)
3. Use `kind: "package-json"` for generated `package.json`, `kind: "ejs"` for rendered templates, and `kind: "static"` for byte-for-byte copies
