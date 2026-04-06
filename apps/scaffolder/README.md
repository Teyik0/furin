# create-furin

Scaffolder officiel pour [Furin](https://github.com/Teyik0/furin) — le meta-framework React construit sur Elysia + Bun.

## Prérequis

- [Bun](https://bun.sh) ≥ 1.0

---

## Utilisation

### Via `bun create` (après publication npm)

```bash
bun create furin my-app
```

### Via `bunx`

```bash
bunx @teyik0/create-furin my-app
```

### En local (développement dans le monorepo)

```bash
bun apps/scaffolder/src/index.ts my-app
```

---

## Options

```
Usage:
  bun create furin <dir>
  bun create furin <dir> --template <simple|full>

Options:
  --template <simple|full>   Choix du template (par défaut : interactif)
  --yes                      Passer les confirmations interactives
  --no-install               Ne pas lancer bun install après la génération
  --version                  Afficher la version de @teyik0/furin ciblée
  --help                     Afficher l'aide
```

### Exemples

```bash
# Mode interactif complet
bun create furin my-app

# Générer directement, sans prompts
bun create furin my-app --template full --yes

# Générer sans installer les dépendances
bun create furin my-app --no-install
```

---

## Templates

### `simple` — Tailwind CSS + route API

```
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

Dépendances : `@teyik0/furin`, `elysia`, `react`, `react-dom`, `bun-plugin-tailwind`, `tailwindcss`

---

### `full` — shadcn/ui + Tailwind CSS + routes API

```
my-app/
├── package.json
├── tsconfig.json           ← path alias @/* → src/*
├── bunfig.toml
├── furin.config.ts
├── furin-env.d.ts
├── components.json         ← config shadcn/ui
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
        ├── globals.css     ← variables CSS oklch (thème clair + sombre)
        ├── root.tsx
        └── index.tsx
```

Dépendances : tout ce qui est dans `simple`, plus `class-variance-authority`, `clsx`, `tailwind-merge`, `@radix-ui/react-slot`, `lucide-react`, `tw-animate-css`

---

## Après la génération

Le scaffolder lance automatiquement :

1. **`bun install`** — installe toutes les dépendances
2. **`git init`** + premier commit `chore: initial scaffold`

Pour démarrer :

```bash
cd my-app
bun dev           # http://localhost:3000
bun test:types    # vérification TypeScript
```

---

## Développement du scaffolder

```bash
# Tests (53 cas)
bun run --filter="create-furin" test

# Vérification TypeScript
bun run --filter="create-furin" test:types
```

### Mettre à jour une version de dépendance

Édite `src/generated/package-catalog.json` — les templates récupèrent automatiquement les nouvelles versions au prochain scaffold :

```json
{
  "@teyik0/furin": "0.1.0-alpha.4",
  "elysia": "^1.4.28",
  "react": "^19.2.4"
}
```

### Ajouter un template

1. Crée le dossier `templates/<id>/` avec les fichiers souhaités
2. Ajoute l'entrée dans `templates/manifest.json` (schema v2)
3. Les fichiers `.ejs` sont rendus via EJS — les autres sont copiés byte-for-byte
