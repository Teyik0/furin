┌─────────────────────────────────────────────────────────────┐
│                      HMR BUN ARCHITECTURE                   │
└─────────────────────────────────────────────────────────────┘
┌──────────────┐    ┌──────────────┐    ┌──────────────────┐
│   WATCHER    │───▶│  DISPATCHER  │───▶│  WEBSOCKET HUB   │
│  (Bun.watch) │    │   (Logic)    │    │ (Bun.serve WS)   │
└──────────────┘    └──────────────┘    └──────────────────┘
       │                    │                     │
       │                    │                     ▼
       │                    │            ┌──────────────────┐
       │                    │            │   CLIENT HMR     │
       │                    │            │   (Browser)      │
       │                    │            └──────────────────┘
       │                    │
       ▼                    ▼
┌──────────────┐    ┌──────────────┐
│   MODULE     │    │   SERVER     │
│ INVALIDATOR  │    │   RELOADER   │
│ (Clear Cache)│    │ (Elysia)     │
└──────────────┘    └──────────────┘

Ce qui Manque vs Vite
Vite fournit tout ça en un seul outil :
┌────────────────────────────────────────────────────────────┐
│                      VITE HMR                              │
├────────────────────────────────────────────────────────────┤
│  1. File Watcher (chokidar)                               │
│  2. Module Graph (dépendances entre fichiers)            │
│  3. WebSocket Server (communication client-serveur)      │
│  4. Client HMR Runtime (dans le navigateur)              │
│  5. React Fast Refresh Plugin (transform + runtime)      │
│  6. Dev Server Middleware (injection du client)          │
└────────────────────────────────────────────────────────────┘
Bun fournit seulement :
┌────────────────────────────────────────────────────────────┐
│                      BUN                                   │
├────────────────────────────────────────────────────────────┤
│  1. File Watcher (Bun.watch) ✅                           │
│  2. Bundler avec hot reload (rebuild auto) ✅             │
└────────────────────────────────────────────────────────────┘
Ce qui manque :
- ❌ Module Graph
- ❌ WebSocket Server pour HMR  
- ❌ Client HMR Runtime
- ❌ React Fast Refresh
- ❌ Dev Server Middleware

La Différence Clé

Bun se contente de :
> "Le fichier a changé → je rebuild le bundle → tu reload la page"
Vite fait :
> "Le fichier a changé → j'analyse quels modules sont affectés → j'envoie un patch au client → React remplace le composant sans perdre le state → pas de reload de page"


Issues Bun HMR - Le Bilan
Problèmes Actuels dans Bun
1. #26075 - server.reload() avec HMR casse le bundler au deuxième request
2. #21076 - Panic HMR sur fichiers statiques  
3. #16839 - Le state des timers/classes n'est pas reset (stale behavior)
4. #23907 - Les imports aliasés ne fonctionnent pas avec HMR
5. #17471 - HMR ne marche pas avec hooks + arrow functions
6. #17598 - import.meta.hot n'existe pas sur le type
7. #17752 - Segfault avec hot reload sur template React
8. #18113 - NextJS + Turbopack = nombre croissant de fast refresh
Ce que ça révèle
- Le HMR Bun fonctionne pour les cas simples (rebuild auto du bundle)
- React Fast Refresh est BROKEN ou très limité
- Pas de module graph pour gérer les dépendances
- Pas de import.meta.hot API complète comme Webpack/Vite
- Les edge cases sont nombreux et mal gérés
