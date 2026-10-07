# Audit du core de Furin

Audit du 7 octobre 2026 sur le workspace courant, après passage à Elysia `2.0.0-beta.23`. Trois agents ont examiné six scopes successifs ; l’agent principal a couvert le build, les adaptateurs, la CLI et les dépendances, puis vérifié plusieurs reproductions indépendamment.

Les constats détaillés ci-dessous décrivent l’état initial de l’audit. Les correctifs sont désormais appliqués avec des régressions dédiées ; leur consolidation est décrite dans la section suivante. Cet audit ne constitue pas une garantie d’absence de vulnérabilité.

Les observations concernent le code local et les API publiques lorsque possible. Les configurations non prises en charge, les preuves avec bundler simulé et les risques sans exploitation démontrée sont qualifiés explicitement. Les changements Elysia préexistants sont conservés. Les API publiques, types exposés et workflows restent identiques.

## Correctifs appliqués

| Références | Résultat |
| --- | --- |
| C1–C4 | Résolution des bindings et aliases statiques ; diagnostic des usages serveur/client ambigus ; toutes les extensions de scripts supportées ; imports et shadowing de l’autofix corrigés |
| C5 | Specifiers et patterns hydrate encodés comme littéraux JavaScript |
| U1 | Identité des queries séparée par client et options, clés opaques sans credentials ; seeds SSR canoniques conservés, variantes ambiguës exclues |
| U2–U4 | Snapshots search stables ; politique commune des liens ; ownership du transport et rechargement après annulation |
| U5 | Union des types lorsque plusieurs routes génèrent la même signature RouteMap |
| S1 | Runtime sync porté par la route ; principal et authentification du propriétaire conservés dans les compositions |
| S2–S3 | Finalisation HTTP partagée ; DTO métier distinct des wrappers HTTP ; statut, headers et corps fidèles lors du replay |
| S4 | Encodage des chemins Unicode et du séparateur, décodage côté client |
| S5 | Pagination du journal attribuable au principal courant ; reset conservateur pour les autres principaux, l’historique et les adaptateurs personnalisés sans provenance |
| R1–R7 | Codec SSR commun préservant les types riches ; streaming progressif et annulable ; readers libérés ; rejets observés ; marqueur not-found conservé ; références RSC distinctes des objets métier |
| D1–D4 | Params natifs conservés et captures décodées ; slash final cohérent ; spécificité partagée ; métadonnées complètes ; réécriture des imports par AST |
| L1–L3 | Registre de montages par application ; configuration de logging par instance, y compris les rendus détachés |
| L4–L5 | Préfixes parents imbriqués pris en compte par le serveur et le client ; montages répétés isolés ; encodage injectif partagé des répertoires d’artefacts |
| L6 | Cleanup Elysia exécuté après le drain HTTP, ISR et logging ; deadline et fermeture WebSocket conservées |
| B1 | Liens des assets déréférencés dans la sortie isolée, sans écriture dans leurs sources |
| B2 | Fingerprint du graphe transitive des dépendances, des manifests et du lockfile Bun, stable entre checkouts |
| B3 | Allocation déterministe des noms Vercel avec contrôle des collisions, avant création des aliases |

Les conventions `_private` sont alignées entre discovery et build. Les recherches ambiguës de contexte compilé renvoient null plutôt que les assets d’une autre application. Le cache mémoire est borné à 1 000 valeurs avec éviction LRU et libération des namespaces vides, sans scan à chaque insertion.

Les dépendances ont reçu les mises à jour compatibles et trois patches Bun documentés dans [patches/README.md](patches/README.md). Le contrôle par versions passe de 26 à 3 avis : ces trois versions restent signalées, mais leurs chemins vulnérables sont corrigés et vérifiés par des tests de sécurité. Les patches s’appliquent automatiquement avec le lockfile actuel ; ils ne suppriment pas les avis d’audit.

Les cas de régression utilisent les API publiques, le vrai serveur Bun ou le vrai bundler lorsqu’ils sont nécessaires. La première consolidation a aussi révélé des régressions de seeds privés PPR et de revalidation avant montage, corrigées sans modifier les attentes des tests existants.

Les tests de composition couvrent les préfixes imbriqués, les guards avant rendu, le 404 personnalisé, les handlers détachés et la réutilisation d’un plugin dans plusieurs applications. Une preuve réseau vérifie que les watchers suivent les nouvelles pages dans chaque montage et qu’arrêter l’un ne ferme pas l’autre. Les assertions de compilation préservent les schémas GET/POST, les décorateurs parents, le logger, les macros sync et la configuration des loaders ; les routes absentes et payloads incorrects restent refusés.

Les documents SSG précompilés conservent leurs snapshots lors d’un montage imbriqué. Un helper commun adapte uniquement les URLs d’assets réservées et les métadonnées de préfixe à la livraison, avec les sélecteurs de [Bun HTMLRewriter](https://bun.sh/docs/runtime/html-rewriter). ISR et les shells PPR utilisent la même opération. L’alternative consistant à invalider le SSG et à relancer ses loaders a été écartée : elle changerait la sémantique de génération au build. Le test public conserve les données et scripts auteur et installe un loader qui échouerait s’il était exécuté au runtime.

Pour un journal PostgreSQL existant, appliquer de nouveau la migration idempotente livrée avec Furin afin d’ajouter `principal_hash`. La migration SQLite est automatique ; les entrées historiques sans provenance provoquent un reset conservateur. Cette migration de stockage ne change pas le contrat du protocole public.

## Priorités

P1 signifie corriger en priorité avant une release : confidentialité, frontière d’autorisation, duplication d’effets de mutation ou contrat essentiel cassé. P2 signifie défaut fonctionnel, de disponibilité ou d’intégrité dans des conditions précisées. Ces niveaux ne sont pas des scores CVSS.

| Priorité | Référence | Défaut |
| --- | --- | --- |
| P1 | C1 | Une méthode isomorphe calculée conserve un secret serveur dans un vrai bundle navigateur |
| P1 | U1 | Le cache query réutilise les données d’Alice après passage aux credentials de Bob |
| P1 | S1 | La composition de deux runtimes sync distincts conserve le principal du premier |
| P1 | S2 | Un DTO métier contenant `status` ou `code` casse l’idempotence non atomique |
| P1 | R1 | L’hydratation SSR perd les types riches et échoue avec BigInt |

## Séparation serveur client et compilation

### C1 P1 Méthodes isomorphes calculées

Dans `packages/core/src/plugin/transform-isomorphic.ts:381`, la validation des méthodes statiques et la reconnaissance de la chaîne ne rejettent pas `const method = 'server'; createIsomorphicFn()[method](() => secret).client(() => 'public')`. Un vrai `Bun.build`, avec le package Furin résolu et le strip plugin, réussit sans diagnostic et contient le marqueur serveur dans le JavaScript navigateur. La chaîne est partiellement transformée sans retirer le callback serveur. Le code navigateur peut ensuite planter ; le secret reste lisible dans le fichier publié.

Reconstruction recommandée : résoudre les bindings du builder puis accepter uniquement la grammaire statique dont la séparation est prouvée ; interrompre le build sur les usages ambigus. Alternative minimale : rejeter les accès calculés associés au builder, puis étendre les cas alias et shadowing avec la même résolution de bindings. Reproduction : `/tmp/furin-audit-compiler.ts`, résultat `computed-real-package-build`.

### C2 P2 Extensions ignorées

`packages/core/src/plugin/index.ts:9` ne traite que `ts`, `tsx`, `js`, `jsx`. Les sources `mjs`, `cjs`, `mts`, `cts` échappent au strip. Avec le vrai package, le cas `.mjs` échoue actuellement à cause d’imports serveur `async_hooks` ; avec un import externalisé, il produit un bundle conservant le callback serveur. La fuite n’est donc pas présentée comme systématique dans un build de production standard.

Recommandation : un registre unique des extensions prises en charge par le scan, les transforms et Bun ; soit les transformer, soit les rejeter explicitement. Alternative : documenter et refuser ces extensions dans les modules Furin. Reproduction : `/tmp/furin-audit-compiler.ts`.

### C3 P2 Autofix des imports et du shadowing

Dans `packages/core/src/plugin/route-config-autofix.ts:787`, `ensureTImport` produit `import { t2 } from 'elysia'` lorsqu’un autre import nommé occupe `t`, au lieu de `import { t as t2 }`. Un import par défaut ou une variable locale nommée `t` provoque une collision. Le traversal à `:425` compte une fonction locale recevant un paramètre `defineRoute` comme une route et déclenche à tort « one route per file ». L’autofix peut ainsi écrire une source cassée au démarrage du développement.

Recommandation : réutiliser la résolution de bindings pour compter les builders et choisir les noms d’import ; ajouter seulement l’alias nécessaire. Alternative : refuser l’autofix ambigu avec un diagnostic utile. Reproduction : `/tmp/furin-audit-autofix.ts`.

### C4 P2 Validation des API tierces

`packages/core/src/plugin/transform-isomorphic.ts:182` valide les arguments de `.server()` et `.client()` avant de confirmer à `:194` que la racine est `createIsomorphicFn`. `export const value = api.server('production')` et `api.client({ name: 'value' })` échouent, même sans import Furin.

Recommandation : identifier le builder et son binding avant toute validation ou transformation. Alternative : filtrer les modules sans import Furin, en sachant que cela ne suffit pas pour les modules mélangeant plusieurs DSL.

### C5 P3 Encodage des sources hydrate

`packages/core/src/build/hydrate.ts:96` et `:119` interpolent des paths et patterns dans du JavaScript sans encodage. Un fichier Unix valide `say"hi.tsx` produit une entrée TSX invalide, confirmée par le parseur.

Recommandation : `JSON.stringify` pour tous les specifiers et patterns injectés. Alternative : interdire ces caractères au discovery, plus restrictif.

## Queries et navigation cliente

### U1 P1 Identité des données privées

`packages/core/src/client/query.tsx:49` et `query-store.ts` identifient une query par son URL. Les headers et options qui changent la réponse ne participent pas à l’identité ; l’effet dépend de `store` et `url`. Avec `createClient<typeof app>` et `useQuery(api.me.get, { headers: { authorization: token } })`, afficher Alice puis passer le token à Bob conserve Alice dans le DOM ; un seul GET est envoyé. Le serveur continue à contrôler l’authentification : le défaut est un mélange de données privées dans le même navigateur.

Recommandation : identité de requête explicite comprenant les variations pertinentes, et cycle de vie du store lié à la session avec purge des caches privés à son changement. Ne pas exposer de tokens bruts dans les clés de diagnostic. Alternative courte : refetch sur changement des options et purge lors du changement de compte ; elle laisse les collisions entre consumers simultanés. Reproduction DOM : `/tmp/furin-client-audit.test.tsx`.

### U2 P2 Sélecteurs de recherche instables

`packages/core/src/client/router/search/index.ts:59` fournit directement au `useSyncExternalStore` le résultat du sélecteur. `useSearch('/', search => ({ page: search.page }))` crée un objet à chaque lecture, puis une boucle « Maximum update depth » sans changement de recherche.

Recommandation : snapshot stable du store, puis sélection mémorisée avec une égalité cohérente. Alternative : imposer des résultats primitifs, ce qui réduit le contrat actuel. Reproduction DOM : `/tmp/furin-client-audit.test.tsx`.

### U3 P2 Comportement des liens

`packages/core/src/client/link.tsx` intercepte les liens `download`, contrairement au filtre appliqué aux ancres natives. Sous `/admin`, un lien absolu de même origine vers `/admin/products` est envoyé comme chemin logique déjà préfixé ; le vrai RouterProvider demande `/admin/admin/products`.

Recommandation : politique unique de normalisation et d’interception pour Link et les ancres, distinguant URL physique et href logique avant navigation. Alternative : deux correctifs locaux avec tests de parité. Reproduction DOM : `/tmp/furin-client-audit.test.tsx`.

### U4 P2 Cache de navigation annulée

`packages/core/src/client/router/provider.tsx:654` et `:685` conservent en cache un RouterState contenant des promesses différées appartenant au stream annulable de la navigation. Aller sur `/a`, partir vers `/b` avant résolution, puis revenir sur `/a` pendant le TTL de 30 secondes réutilise la promesse rejetée avec `AbortError` ; `Await.silenceAbortError` la transforme en promesse qui ne se résout jamais. Le DOM reste en attente et aucun nouveau chargement de A n’a lieu.

Recommandation : ownership explicite du transport ; invalider une entrée annulée ou ne publier en cache que des états réutilisables. Alternative : supprimer l’entrée lors de l’abort, tout en protégeant les préchargements encore consommés. Reproduction DOM : `/tmp/furin-client-audit.test.tsx`.

### U5 P2 Signatures RouteMap dupliquées

`packages/core/src/shared/route-map.ts:6` et `:33` génèrent la même signature `[path: \`/blog/${string}\`]` pour `/blog/:id` et `/blog/*`. TypeScript 7.0.2 émet deux diagnostics TS2374 sur le fichier généré.

Recommandation : regrouper les signatures identiques et émettre une union de leurs types, en gardant les patterns précis. Alternative : dériver RouteMap depuis RoutePatternMap pour éviter les deux représentations indépendantes. Reproductions : `/tmp/furin-route-map-check.ts` et `/tmp/furin-route-map-tsconfig.json`.

## Synchronisation et invalidation

### S1 P1 Runtimes distincts dédupliqués

`packages/core/src/server/sync/plugin.ts:338` utilise le nom fixe `furin-sync`. Composer deux vrais plugins Furin sous `/a` et `/b`, chacun avec son runtime sync et ses API associées, conserve les closures du premier plugin. La route B dont le principal exige normalement une authentification renvoie 200 sans celle-ci ; son principal n’est jamais appelé et le reçu porte le namespace A.

La documentation demande un runtime partagé et ne promet pas deux runtimes indépendants sur la même application. Le problème est que cette composition acceptée silencieusement remplace le resolver de principal configuré. La preuve ne contourne pas un éventuel guard Elysia supplémentaire. Recommandation immédiate : rejeter les runtimes incompatibles au niveau de l’application Elysia finale. Architecture durable : runtime porté par chaque route, avec un pipeline global unique qui le résout. Des noms simplement uniques risquent de superposer des hooks globaux. Reproduction publique : `/tmp/furin-audit-multi-furin.ts`.

### S2 P1 DTO métier et idempotence

`packages/core/src/server/auto-invalidate/runtime.ts:29`, utilisé par `sync/plugin.ts:320`, lit `status` ou `code` dans un objet métier comme s’il décrivait le statut HTTP. Un handler non atomique qui incrémente une valeur en SQLite puis retourne `{ status: 500 }` avec un vrai HTTP 200 abandonne le reçu. Répéter la même clé d’idempotence exécute la mutation deux fois et saute l’invalidation. Le chemin atomique traite déjà ce cas correctement.

Recommandation : interpréter uniquement les wrappers HTTP réels, les `Response` et le statut effectif Elysia ; partager cette normalisation entre chemins atomique et non atomique. Alternative : corriger uniquement le détecteur actuel, avec risque de maintenir la divergence. Reproductions : `/tmp/furin-audit-sync.ts`, `/tmp/furin-audit-sync-more.ts`.

### S3 P2 Rejeu différent de la réponse initiale

`packages/core/src/server/sync/response.ts:140` et `:171` n’appliquent pas la même priorité entre `set` et `Response` que le résultat HTTP final. `set.status = 303`, une location `/old`, puis une `Response` avec location `/actual` donne initialement 303 `/actual`, mais un rejeu 200 `/old`. Les statuts 201 et 500 présentent aussi une divergence ; un échec peut être enregistré comme succès.

Recommandation : finalisation HTTP commune pour le statut, les headers et le corps, avec stratégies de commit atomique et non atomique séparées. Alternative : patcher la priorité uniquement dans le chemin non atomique. Reproduction : `/tmp/furin-audit-headers.ts`.

### S4 P2 Chemins Unicode et headers

`packages/core/src/server/auto-invalidate/runtime.ts:121` joint des chemins bruts dans `x-furin-revalidate`. Une scope `/東京` provoque une erreur de header et une réponse 500 après l’effet métier ; deux appels non atomiques exécutent deux fois le handler.

Recommandation : encodeur et décodeur communs produisant une représentation URL valide ; tester aussi le séparateur pour les chemins qui le contiennent. Alternative : refuser explicitement les scopes non représentables avant le handler. Reproduction : `/tmp/furin-audit-headers.ts`. L’ambiguïté des virgules reste un cas à tester, distinct de l’échec Unicode confirmé.

### S5 P2 Journal de rattrapage incomplet

`packages/core/src/server/sync/stream.ts:169` renvoie toujours `changes: []`, `hasMore: false` et un reset dès que le cursor diffère. Le paramètre `limit` est validé mais ignoré ; `readChanges` n’est pas appelé. Le journal paginé et les invalidations ciblées décrits dans `apps/docs/src/content/docs/sync.mdx` ne sont pas fournis par cet endpoint. Le reset global évite actuellement de diffuser les scopes privés d’un journal partagé.

Recommandation : assumer et documenter le protocole cursor plus rafraîchissement global tant qu’un journal filtré par autorisation n’existe pas. Alternative : implémenter pagination et filtrage autorisé ; exposer le journal partagé brut ne convient pas.

## Rendu et transports

### R1 P1 Types riches et hydratation SSR

`packages/core/src/server/render/document.tsx:38` et `shell.ts:31` sérialisent les loaders initiaux avec `JSON.stringify`, alors que la navigation NDJSON préserve les types riches. Une Date rend correctement côté serveur puis devient une chaîne dans les données d’hydratation ; Map devient `{}` et BigInt ou un cycle font échouer le rendu. La route publique reproduite appelle `date.getUTCFullYear()` et perd donc son contrat lors de l’hydratation.

Recommandation : codec symétrique commun à l’hydratation, la navigation et les modes de rendu, en conservant l’échappement du contexte HTML. Alternative : limiter publiquement les loaders à JSON, ce qui réduirait le contrat existant. Reproduction HTTP et inspection du payload : `/tmp/furin-render-audit.ts`. L’hydratation dans un vrai navigateur reste à ajouter aux tests.

### R2 P2 Résolutions différées non progressives

`packages/core/src/server/render/ssr.ts:1024` collecte le second TransformStream avec `.text()` avant d’injecter ses données. Le shell part, mais une promesse lente empêche la valeur d’une promesse déjà résolue d’atteindre le client ; les deux arrivent ensemble après la dernière résolution.

Recommandation : envoyer les frames à chaque résolution avec la barrière nécessaire pour initialiser le registre. Alternative : multiplexer dédié si plusieurs producteurs le justifient. Reproduction à promesses contrôlées : `/tmp/furin-render-audit.ts`.

### R3 P2 Rendu après annulation

`packages/core/src/server/render/ssr.ts:220` ne transmet pas `request.signal` à React ; le pump autour de `:1012` ne libère pas systématiquement son reader à l’annulation. Après annulation du reader HTTP et du Request, résoudre une promesse différée rend encore le sous-arbre. Cela démontre du travail inutile ; aucun épuisement de ressources sous charge n’a été mesuré.

Recommandation : propager le signal et centraliser cancel/release dans la terminaison du transport, comme le chemin PPR le fait déjà. Alternative : `pipeTo` avec propagation de l’annulation lorsque la transformation le permet. Reproduction : `/tmp/furin-render-audit.ts`.

### R4 P2 Not Found perdu en rendu bufferisé

`packages/core/src/server/render/ssr.ts:482` produit le HTML 404 et le fallback de `notFound`, mais omet `__furinNotFound` du payload initial et du NDJSON dans le chemin bufferisé utilisé pour le prerender. Le chemin SSR streaming conserve ce marqueur ; le client peut donc reconstruire la page normale sur un export contenant le fallback.

Recommandation : construction commune du résultat de route et de ses marqueurs pour SSR, SSG et ISR. Alternative : ajouter le marqueur au chemin bufferisé avec tests de parité. Reproduction : `/tmp/furin-render-audit.ts`.

### R5 P2 Rejet non observé

`packages/core/src/shared/deferred-ndjson.ts:139` appelle `completion.finally` sans observer la promesse retournée. Une première frame valide suivie d’une ligne invalide produit un rejet global, même si le consommateur observe le rejet de sa donnée différée.

Recommandation : observer aussi la promesse de cleanup sans masquer l’erreur du consommateur. Alternative : cleanup via deux branches de `then`. Reproduction transport : `/tmp/furin-render-audit.ts`.

### R6 P2 Reader verrouillé après erreur initiale

`packages/core/src/shared/deferred-ndjson.ts:113` à `:150` ne protège pas toute l’initialisation par les chemins de cleanup. Une première ligne JSON invalide, une première lecture échouée ou un début RSC incomplet peuvent rejeter le parseur en laissant `stream.locked === true`.

Recommandation : un propriétaire du reader dès son acquisition, avec transfert explicite à la phase streaming et cleanup pour tous les échecs. Alternative : ajouter les cleanup manquants dans chaque branche, plus fragile face à de nouvelles branches. Reproduction : `/tmp/furin-render-audit.ts`.

### R7 P2 Collision avec un descripteur RSC

`packages/core/src/shared/route-frame.ts:234` reconnaît un objet métier contenant `__furinRsc` comme un descripteur de protocole. Un loader valide `{ user: { __furinRsc: 'ordinary-user-field' } }` dans un flux différé échoue ensuite avec une erreur de RSC incomplet.

Recommandation : enveloppe ou échappement du protocole qui distingue les valeurs utilisateur des descripteurs. Alternative : réserver explicitement ces champs et valider à la production du payload, en réduisant la liberté des objets métier. Reproduction : `/tmp/furin-render-audit.ts`.

## Routing et développement

### D1 P2 Paramètres et trailing slash divergents

`packages/core/src/server/router/patterns.ts:250` et `:288`, puis `furin.ts:594` et `:608`, remplacent les params Elysia par des captures brutes. `/item/caf%C3%A9` donne `caf%C3%A9`, et `a%2Fb` donne `a%2Fb`, au lieu des valeurs décodées natives. `/item/name/` retourne 404 en HTML et en data Furin alors que la route native Elysia accepte ce slash final.

Recommandation : préserver les params et le matching d’Elysia sur les routes natives ; limiter le matcher indépendant aux besoins réels du développement. Alternative : matcher commun reproduisant complètement les règles Elysia, avec coût de maintenance accru. Aucun contournement d’autorisation n’est démontré. Reproduction production : `/tmp/furin-audit-routing.ts`.

### D2 P2 Priorité des valeurs de recherche

`packages/core/src/shared/search-params.ts:37` classe le wildcard avant la racine : pour `/` avec `page = 1` et `/*` avec `page = 2`, le matcher de route choisit `/` mais `findSearchDefaults` choisit 2. Les liens peuvent retirer le mauvais paramètre explicite.

Recommandation : une seule règle de spécificité partagée par le routing et les métadonnées search. Alternative : corriger localement le comparateur, au prix d’une duplication persistante.

### D3 P2 Routes sans defaults ignorées

`packages/core/src/server/router/schemas.ts:329` omet les routes sans valeurs de recherche par défaut. Pour `/products/new` sans defaults et `/products/:id` avec `tab = details`, le second fournit à tort les defaults du premier et peut retirer `tab=details` du lien.

Recommandation : conserver toutes les routes dans la résolution ; `searchDefaults` peut rester absent. Alternative : un lookup préalable de la route réelle avant le lookup des defaults.

### D4 P2 Réécriture de chaînes utilisateur

`packages/core/src/server/dev-page-plugin.ts:149` remplace les imports de singletons par regex sur tout le texte. La chaîne valide `"import React from 'react';"` est réécrite en code invalide ; des template literals peuvent être modifiés et contenir le chemin local du package.

Recommandation : reconstruire cette petite transformation avec l’AST et les seuls nœuds import. Alternative : limiter la regex ne traite pas fiablement commentaires, chaînes et grammaire JavaScript. Reproduction : `/tmp/furin-audit-routing.ts`.

## Runtime et observabilité

### L1 P2 Registre global et serveurs indépendants

`packages/core/src/server/instance.ts:114` utilise le trafic comme preuve supposée qu’un serveur est arrêté. Après une requête sur une application A, créer une application B avec un autre pagesDir et le même prefix remplace l’entrée globale ; une nouvelle requête sur A rend la page de B. Les deux applications sont toujours vivantes.

Recommandation : registre appartenant à l’application Elysia, capture de l’instance dans ses handlers et libération explicite au lifecycle. Alternative immédiate : refuser toute collision sans heuristique de trafic et réinitialiser explicitement les fixtures de test. Reproduction publique revalidée : `/tmp/furin-audit-runtime-config.ts`.

### L2 P2 Configuration de logging dédupliquée

`packages/core/src/server/evlog.ts:51` utilise le nom fixe `furin-evlog`. Deux Furin sous `/a` et `/b` avec drains différents, composés sur un root, envoient trois requêtes A/B/A au drain A et zéro au drain B. Les options B ne sont pas prises en compte ; la preuve concerne les drains, les conséquences d’une redaction différente doivent être testées séparément.

Recommandation : une intégration globale qui choisit la configuration de l’instance propriétaire de la requête. Alternative : exiger une configuration de logging commune et rejeter les overrides incompatibles. Multiplier les wrappers peut doubler les émissions. Reproduction : `/tmp/furin-audit-logger-config.ts`.

### L3 P2 Drain synthetic ignoré

`packages/core/src/server/context-logger.ts:66` et `furin.ts:411` ne transmettent pas le drain d’instance au logger des rendus détachés. Après configuration réelle de `furin({ logger: { drain } })`, une requête appelle le drain ; un événement émis par `runInSyntheticRenderScope`, utilisé pour `renderForPath`, apparaît sur stdout mais jamais dans ce drain. La documentation promet pourtant les logs SSG et ISR vers le drain configuré. Le helper réel est exercé, sans cycle ISR complet.

Recommandation : options de logging de l’instance propagées aux événements synthetic via le toolkit evlog. Alternative : configurer et documenter un logger process-global explicite. Reproduction : `/tmp/furin-audit-synthetic-logger.ts`.

### L4 P2 Prefix parent composé

`packages/core/src/furin.ts:504` et `:653` enregistrent le prefix Furin sans le prefix parent Elysia. `new Elysia({ prefix: '/host' }).use(await furin({ prefix: '/a', pagesDir }))` crée une route `/host/a/`, mais GET `/host/a` retourne 500 faute de renderer retrouvé.

Recommandation : résoudre le montage physique dans le root et aligner registre, assets, URLs et manifeste client. Alternative immédiate : rejeter les prefixes parents non vides. Modifier le dispatcher seul laisserait les autres URLs incohérentes. Reproduction dev : `/tmp/furin-audit-parent-prefix.ts`.

### L5 P2 Collision des artefacts dev

`packages/core/src/furin.ts:786` remplace `/` par `__` dans le slug. Les prefixes `/a__b` et `/a/b` sont acceptés puis écrivent le même `.furin/a__b/_hydrate.tsx` ; la seconde entrée écrase la première. Le rendu serveur reste correct dans la reproduction ; le résultat navigateur/HMR n’a pas été exercé.

Recommandation : encodage injectif commun au développement et au build. Alternative : détecter et refuser les collisions de répertoires dev. Reproduction : `/tmp/furin-audit-dev-slug.ts`.

### L6 P2 Shutdown contourne le cleanup Elysia

`packages/core/src/server/production-server.ts:92` et `:101` appellent `server.stop()` natif. Avec un vrai serveur Bun et `app.cleanup`, le shutdown Furin appelle zéro cleanup et laisse `app.server` défini ; un `app.stop(true)` supplémentaire appelle le cleanup et retire la référence. Le lifecycle Elysia 2 est contourné.

Recommandation : `app.stop()` et `app.stop(true)` pour les chemins normal et forcé, en conservant le drain des connexions et la deadline. Alternative : ajouter un cleanup manuel, moins fiable car Elysia reste propriétaire de ses ressources. Reproduction publique revalidée : `/tmp/furin-audit-shutdown-cleanup.ts`.

## Build et déploiement

### B1 P2 Lien symbolique dans un export statique

`packages/core/src/adapter/static.ts:504` copie les symlinks de public, puis `:197` écrit le prerender à travers ces liens. Avec `public/blog` pointant vers un dossier extérieur, l’export de `/blog` remplace le `index.html` extérieur. Les fixtures et le rendu sont réels ; seul le bundler client est simulé. Le déclencheur est un lien dans les sources locales de l’application, pas une requête distante non authentifiée.

Recommandation : politique de liens explicite et vérification de containment réel avant chaque écriture ; refuser un lien sortant de l’export. Alternative : copier les fichiers déréférencés dans une sortie isolée. Reproduction revalidée : `/tmp/furin-audit-static-symlink.ts`.

### B2 P2 Build ID insensible aux dépendances serveur

`packages/core/src/adapter/runtime-build.ts:149` exclut tous les imports sous node_modules de la fingerprint. Modifier le code et la version d’une dépendance utilisée seulement côté serveur, sans changer les chunks client, conserve la fingerprint et le build ID. Le calcul est reproduit directement ; le risque de réutilisation d’artefacts suit du fait que les caches SSR/PPR/ISR utilisent le build ID, sans reproduction d’un déploiement Redis complet.

Recommandation : fingerprint de l’artefact serveur et des dépendances externalisées, ou au minimum entrée de lockfile pertinente. Alternative : identifiant unique par déploiement, plus simple mais qui perd la réutilisation déterministe. Reproduction revalidée : `/tmp/furin-audit-fingerprint.ts`.

### B3 P2 Collision de noms Vercel

`packages/core/src/adapter/vercel.ts:205` transforme `/` et `/index` en `index-ssg`. `createFunctionAlias` à `:290` échoue avec EEXIST lorsque les deux routes SSG sont présentes. Le vrai `buildApp` et le générateur d’artefacts sont exécutés ; seul le bundler client est simulé.

Recommandation : nommage injectif incluant un identifiant stable de route et validation des collisions avant écriture. Alternative : réserver un nom root impossible à produire pour une route ordinaire, puis contrôler les autres collisions. Reproduction revalidée : `/tmp/furin-audit-vercel-collision.ts`.

## Dépendances

`bun audit --json` signale 26 avis concernant 12 noms de packages, dont 19 high et 7 moderate. Ce décompte couvre le workspace installé ; il ne démontre pas 26 failles accessibles dans le runtime Furin. Résultat brut : `/tmp/furin-core-audit-dependencies.json`.

Packages signalés : baseline-browser-mapping, brace-expansion, braces, browserslist, deepmerge-ts, esbuild, fast-uri, js-yaml, mysql2, postcss-selector-parser, smol-toml et source-map-js. Les chemins examinés passent principalement par les outils de développement, Prisma et la documentation ; certains peers sont installés via react-server-dom-webpack. Furin construit avec Bun et n’exécute pas le serveur de développement esbuild ou webpack.

Les overrides de brace-expansion et fast-uri ne suffisent plus à éliminer les avis présents. Mettre à jour les versions réellement résolues, vérifier les incompatibilités, puis relancer l’audit est préférable à ajouter des overrides majeurs sans validation. Les avis officiels confirment notamment les problèmes de récursion de [brace-expansion](https://github.com/advisories/GHSA-qhr7-859c-m2p7), de sérialisation d’autorité de [fast-uri](https://github.com/advisories/GHSA-qw65-cvwx-89v3) et de sections de [source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).

## Décisions d’architecture retenues

| Scope | Recommandation | Alternative et compromis |
| --- | --- | --- |
| Instances et plugins globaux | Registre faible par application, ownership de route et hooks globaux uniques ; nouveau runtime complet pour chaque réutilisation du plugin | Rejeter les compositions incompatibles ; moins de code, fonctionnalités multi-runtime limitées |
| Compiler serveur client | Résolution de bindings commune, grammaire prouvable et arrêt sur ambiguïté | Rejeter quelques syntaxes localement ; rapide mais risque de divergences AST |
| Sync | Un résultat HTTP final commun et deux stratégies de commit | Réparer chaque branche ; conserve les différences de statut et replay |
| Hydratation et navigation | Codec commun avec enveloppes de protocole distinctes des données utilisateur | Restreindre les loaders à JSON et réserver des clés ; contrat réduit |
| Streaming | Owner explicite pour chaque reader, signal et promise ; terminaison commune | Cleanup ajouté dans chaque branche ; maintenance fragile |
| Queries | Identité par client et variations explicites de requête ; seeds SSR locaux à la requête | Refetch des options et purge manuelle ; collisions simultanées possibles |
| Routing | Elysia comme autorité des routes natives, métadonnées de spécificité partagées | Réimplémentation complète du matcher ; parité coûteuse avec chaque beta |
| Dev transforms | Refaire la réécriture des imports avec l’AST existant | Regex plus complexe ; ne représente pas la grammaire JavaScript |

La refonte reste ciblée sur ces frontières et conserve les API publiques. Une réécriture totale du framework n’est pas justifiée par les preuves actuelles. Les tests publics reproduisant les défauts ont été exécutés avant les corrections, puis les branches responsables ont été refactorées selon le skill TDD de Matt Pocock.

Le bridge de composition est isolé dans `server/elysia-owner.ts`. Elysia beta ne fournit pas l’application finale à son wrapper `wrap` ; les getters `fetch` et `handle` délèguent donc au framework tout en associant les wrappers Furin à leur propriétaire. Le comportement des applications sans Furin est conservé, et des bindings partagés rendent l’installation idempotente. La solution idéale en amont serait un owner fourni directement par Elysia ; un hook `beforeHandle` arrive trop tard pour l’instrumentation et la réécriture des requêtes de navigation. Ce bridge dépend de la structure interne de la beta et doit conserver ses tests de compatibilité lors des prochaines mises à jour.

Les registres process-wide d’instances et de graphes utilisent des références faibles. Ils ne prolongent pas eux-mêmes la durée de vie des applications. Une limite externe demeure : dans la reproduction Bun/Elysia utilisée, une application Elysia minimale ayant exécuté `handle()` reste retenue après des cycles de GC, même sans Furin. Les tests de collecte des buckets non dispatchés et de suppression des références faibles ne constituent donc pas une preuve de collecte complète d’une application dispatchée.

La séparation par module de [Next.js](https://nextjs.org/docs/app/guides/data-security) favorise des frontières serveur/client explicites. Les clés de [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/guides/query-keys) incluent les variables qui changent les données. [Next.js use cache](https://nextjs.org/docs/app/api-reference/directives/use-cache) inclut l’identité du build dans son cache. Ces approches soutiennent le choix proposé pour Furin ; elles ne prouvent pas sa correction.

[Next.js basePath](https://nextjs.org/docs/app/api-reference/config/next-config-js/basePath) fixe le préfixe au build. Furin promet une composition de plugins Elysia ; conserver cette DX demande de résoudre le préfixe physique au montage et de le transmettre au client, plutôt que d’imposer un rebuild pour chaque parent. Le [contexte des middlewares TanStack Start](https://tanstack.com/start/latest/docs/framework/react/guide/middleware) transmet explicitement les données aux étapes suivantes. J’en retiens pour Furin un ownership explicite de l’instance et du principal, plutôt qu’une sélection globale dépendant du dernier trafic.

[TanStack Start](https://tanstack.com/start/latest/docs/framework/react/guide/streaming-data-from-server-functions) expose un transport progressif pour les données streamées ; [React](https://react.dev/reference/react-dom/server/renderToReadableStream) fournit un signal d’annulation au rendu. Furin peut conserver son architecture Bun et ses modes de rendu en alignant la livraison progressive et l’annulation sur ces primitives. La déduplication nommée est un comportement documenté d’[Elysia](https://elysiajs.com/essential/plugin) ; les noms fixes doivent donc correspondre à une responsabilité réellement globale.

## Duplication et complexité

La finalisation HTTP, le codec de rendu, le cleanup du transport, la spécificité des routes, le parsing des invalidations et le nommage des artefacts sont désormais partagés. Les pistes restantes ci-dessous sont des propositions de maintenance, pas des défauts supplémentaires démontrés. Supprimer une façade typée ou reconstruire une fonctionnalité sans défaut reproduit ajouterait du risque au contrat public ; ces changements ne font pas partie des correctifs retenus.

- Supprimer ou reconstruire `createDataEndpoint` après migration de ses tests vers le vrai plugin public : ce chemin historique n’a pas de caller runtime de production et entretient une validation synthétique distincte du rewrite Elysia réel.
- Centraliser parsing et publication des diagnostics de développement, actuellement répartis entre DevGraph et DevDiagnosticStore, en gardant le graphe distinct de la présentation.
- Étendre le transport partagé de RouterProvider à une transaction de navigation commune si une divergence de commit entre navigation et popstate est reproduite ; conserver les abonnements et le rendu dans le provider.
- Garder les façades typées de `define-route.ts` et mutualiser l’assemblage runtime répété entre builders. Alternative plus limitée : mutualiser seulement les étapes terminales ; aucun défaut ne justifie de refaire toute l’API publique.

Le bridge de composition Elysia est désormais isolé et testé. Les usages internes `handler`, `~dispatch` et tuples de routes restent des points de compatibilité à vérifier à chaque upgrade beta ; ils ne deviennent pas des dépendances publiques pour les applications.

Les deux points de performance ont été mesurés et corrigés : cache mémoire borné avec insertion sans scan ; invalidation Redis par lots ordonnés, filtrant les membres avant leur décodage. À 64 000 entrées, la comparaison alternée sur les mêmes données donne 119,13 → 33,08 ms. Redis conserve les indexes globaux et les garanties de rolling deploy, donc le parcours reste O(N). Un index page/layout éliminerait ce coût mais l’ancien protocole ne permet pas de conserver l’énumération bidirectionnelle des chemins entre anciennes et nouvelles replicas sans un fallback global.

## Revue indépendante et corrections de la PR

La [PR #164](https://github.com/Teyik0/furin/pull/164) fait l’objet d’une nouvelle revue indépendante, puis d’une boucle CI et Cubic. La première revue Cubic contient 45 signalements ; ils sont vérifiés par reproduction et ne constituent pas tous des défauts confirmés.

- La réutilisation d’un conteneur Elysia préconstruit demande un runtime complet par application finale et montage physique, en conservant les guards des conteneurs. Une copie superficielle de buckets laisse les closures, watchers et renderers attachés au premier runtime.
- Le compilateur résout maintenant les aliases locaux et transitifs dans leur scope lexical. Les factories opaques ou mutables sont refusées explicitement, les DSL shadowées sont conservées. Les tests passent par le vrai bundler browser et vérifient l’absence des secrets serveur.
- La CI a détecté un coût quadratique de résolution des aliases dans les gros modules générés. Les bindings sont indexés par nom dans chaque analyse ; les passes spécifiques sont évitées seulement après que l’AST a confirmé l’absence d’imports Furin concernés. Un cache global d’analyses aurait compliqué l’invalidation HMR sans corriger l’algorithme. Sur trois nouveaux processus Bun par app, les médianes locales du premier HTML passent de 1 720 à 955 ms pour les docs, de 1 221 à 451 ms pour Task Manager et de 1 214 à 326 ms pour Weather ; les seuils CI restent identiques.
- Les seeds SSR avec options explicites conservent une identité opaque unique par store, sans sérialiser les options. Les bindings et métadonnées PPR restent disponibles ; un consommateur browser obtient sa propre variante, et une lecture sans options ne reçoit pas les données de cette variante. Les defaults du client restent liés à sa session. Supprimer tous ces seeds aurait perdu les métadonnées existantes.
- Le streaming React conserve uniquement le suffixe nécessaire aux fermetures HTML et livre les reveals Suspense sans attendre toutes les boundaries. Les descriptions de head et le HTML des snapshots partagent le rebasing du montage.
- Le codec d’invalidation échappe le chemin avant d’ajouter le marqueur layout. Les chemins Unicode, pourcentages et suffixes littéraux `:layout` restent distincts. Le client consomme réellement les objets typés du journal, récupère les identités de query depuis les tags et invalide les routes pour les tags sans identité connue.
- Les noms d’assets distinguent les majuscules sur les systèmes de fichiers insensibles à la casse et échappent les caractères réservés Windows. Le fingerprint des sources de l’app ne remonte plus vers des manifests étrangers ; le lockfile du workspace reste pris en compte.
- La migration SQLite vérifie et ajoute la provenance sous transaction immédiate, testée avec 24 Workers sur une ancienne base WAL. Le replay normalise les noms de headers ; le fallback d’une réponse non rejouable conserve ses propres headers de représentation.
- Le timeout d’arrêt empêche un ancien drain de reprendre ses étapes et de fermer les subscriptions d’un autre serveur. Les erreurs de drain evlog ne remplacent déjà pas les résultats de rendu ; un test protège cette garantie.
- Le cache mémoire retire les valeurs expirées avant d’évincer une valeur vivante, grâce à un index d’expiration borné avec un nœud par entrée. Les écritures sans TTL restent O(1), les TTL coûtent O(log N). Un scan global à chaque écriture aurait réintroduit le coût mesuré ; nettoyer seulement la tête LRU ne couvre pas les expirations récentes. Sur 64 000 écritures après warmup, le surcoût observé de l’index reste inférieur à 4 ms dans la mesure locale partagée ; ce chiffre n’est pas un budget de production.
- Les aliases et branches isomorphes conservent des sourcemaps vers le fichier original. La sélection imbriquée de branches est compilée récursivement, et l’annulation pendant le premier frame libère aussi le verrou du reader. Les instances seulement créées restent suivies pour le cleanup sans influencer la sélection du seul runtime monté.
- Les preuves de composition utilisent des sous-processus asynchrones dont les sorties sont drainées immédiatement ; leurs timeouts conservent les diagnostics. Le test de libération attend la fin de l’initialisation puis la collecte pendant une durée bornée, avec un contrôle négatif de forte rétention. Les réponses et sockets du test de watchers sont entièrement consommées et fermées. Les assertions d’isolation et de collecte restent identiques ; cinq cycles immédiats de GC ne constituent pas une garantie de collecte du runtime.

Plusieurs signalements supposaient le comportement de Node ou d’anciennes versions d’Elysia. Sous Bun, les `require` sans extension TypeScript participent déjà au fingerprint ; Elysia beta.23 accepte `handle(string)` et renvoie la promesse d’arrêt native. Les tests de compatibilité gardent ces comportements. Drizzle Kit charge sa configuration TypeScript et génère une migration avec la version esbuild résolue. Les assets désignés dans `public/`, y compris les liens explicites vers des dossiers d’assets externes, restent publiables ; imposer une nouvelle restriction de racine aurait modifié cette DX.

## Validation initiale des corrections

Après le dernier correctif SSG :

- `bun run fix` : 745 fichiers contrôlés, aucune erreur ni correction restante.
- `bun run build` : core, scaffolder, documentation et les deux exemples reconstruits avec succès.
- `bun run tscheck` : tous les workspaces passent, y compris les assertions de contrat public.
- `bun run test` : 2 059 tests passants, 103 ignorés, aucun échec. Le core compte 1 871 tests passants et 6 228 assertions sur 233 fichiers.
- PostgreSQL/Prisma/Drizzle/Redis réels : 59 tests passants et 201 assertions dans l’exécution dédiée. Ce nombre n’est pas ajouté au total comme un ensemble de tests uniques.
- `bun install --frozen-lockfile` : les patches de dépendances s’appliquent correctement ; tests de sécurité et compatibilité passants.
- `bun audit --json` : trois avis par version, correspondant exactement aux trois dépendances patchées ; aucun avis masqué.
- Le registre Elysia confirme `next = 2.0.0-beta.23`, version installée dans le workspace.
- `git diff --check` : aucune erreur d’espaces.

Logs finaux : `/tmp/furin-final-{fix,build,tscheck,test}.log`, `/tmp/furin-services-validation.log`, `/tmp/furin-dependency-audit-final.json`. Les tests conditionnels navigateur HMR et les services sans variables d’environnement sont ignorés dans la commande globale ; les services ont été validés séparément comme indiqué ci-dessus.

## Vérification initiale et limites

La mise à jour Elysia a déjà passé typecheck, lint avec `fix`, build des workspaces et suite complète : 1966 tests passants et 99 ignorés, dont 1778 passants dans le core. Pendant l’audit, les exécutions ciblées connues sont : sync/cache 101, routing/dev 315 exécutions dont certaines répétées, rendu/transport 23, client 91, compiler/build auxiliaire 211, runtime 32 et build/adaptateurs/CLI 77. Les nombres ne sont pas additionnés comme une couverture de tests uniques.

Les cinq tests DOM temporaires de `/tmp/furin-client-audit.test.tsx` affirmaient les comportements défectueux observés. Le compiler, les reproductions build et l’isolation des deux applications avaient aussi été relancés par l’agent principal. Des tests permanents inversent désormais ces attentes pour vérifier les correctifs.

L1 à L5 avaient été reproduits en développement, sauf le helper synthetic qui exerce son pipeline commun. L6 utilise réellement le lifecycle de production. La divergence initiale de conventions `_private` entre scan build et discovery runtime donnait 404 ; aucune exposition n’avait été démontrée. Les conventions sont maintenant alignées, les aliases de builders pris en charge et les contextes compilés ambigus refusés.

Aucun XSS, contournement CSP ou bypass des protections host/origin des DevTools n’a été reproduit dans les scopes examinés. Les validations DOM utilisent le harness Bun ; l’ouverture du preview T3 a indiqué que l’automatisation navigateur était indisponible. Un vrai navigateur, le fuzzing des source maps et des tests de charge réseau supplémentaires permettraient d’étendre ces conclusions. Les services Redis/Postgres étaient absents pendant la première passe ; les suites ont ensuite été exécutées sur des services réels jetables.

La seconde passe du scope runtime a subi un échec automatique de l’agent lors de la revue de sécurité ; une revue de logique et de maintenabilité a ensuite repris et fourni L1 et L2. Cette interruption limite la profondeur de la seconde passe sécurité, sans invalider les reproductions déjà obtenues.

Les scripts et logs sous `/tmp` sont locaux et temporaires. Les reproductions initiales sont conservées comme preuves ; les tests permanents inversent leurs attentes pour vérifier les correctifs. Les suites réelles PostgreSQL/Prisma/Drizzle/Redis passent : 59 tests, 201 assertions, couvrant pagination autorisée, concurrence, TTL et anciennes leases. Les services jetables ont été arrêtés et supprimés.
