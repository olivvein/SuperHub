# SuperHub - Statut d'implementation

Date: 2026-03-01

Ce document resume ce qui a ete implemente dans le repo, les problemes rencontres/corriges, et le reste a faire pour alignement complet avec la spec initiale.

## 1. Travail effectue

### 1.1 Structure projet

- Monorepo TypeScript initialise avec workspaces npm:
  - `packages/contracts`
  - `packages/hub`
  - `packages/sdk`
- Configuration TS racine + scripts npm pour `build`, `dev`, `typecheck`.

### 1.2 Package `@superhub/contracts`

- Envelope protocolaire versionnee (`HubEnvelope`) + types de messages:
  - `event`, `cmd`, `rpc_req`, `rpc_res`, `state_patch`, `presence`, `error`
- Schemas Zod pour payloads principaux:
  - presence, subscribe, rpc request/response, state set/patch
- Registre de contrats avec validation par `name + schemaVersion`.
- Erreurs normalisees (`hubError`, `normalizeRpcError`).

### 1.3 Package `@superhub/hub`

- Serveur Fastify + WebSocket avec modules fonctionnels:
  - Gateway HTTP `/api/*`
  - Gateway WS `/ws`
  - Registry clients/services
  - Router pub/sub et routage cible (`clientId`, `serviceName`, broadcast)
  - RPC routing (provider selection + correlation + timeout)
  - State store (set/get/patch/watch)
  - Observabilite (logs JSON, metrics, inspector)
- Endpoints HTTP implantes:
  - `GET /api/health`
  - `GET /api/services`
  - `GET /api/clients`
  - `GET /api/topics`
  - `GET /api/messages`
  - `GET /api/state` (`path`/`prefix`)
  - `GET /api/config`
  - `GET /api/metrics`
  - `POST /api/publish`
  - `POST /api/rpc`
- Securite LAN minimale:
  - token partage (`X-Hub-Token` ou query `token` pour WS)
  - allowlist subnets (IPv4/IPv6 + wildcard `*`)
  - rate limiting par session
  - limite de taille des messages
- Robustesse:
  - heartbeat ping/pong
  - dedup courte des IDs
  - backpressure avec queue bornees et drops
- Persistance SQLite optionnelle (`better-sqlite3`):
  - `services_last`
  - `state_snapshot`
  - `audit` + retention TTL
- Console web:
  - Dashboard, services, clients, inspector, state viewer, config
  - page pairing (`/console/pair`) avec QR code (payload URL+token)

### 1.4 Package `@superhub/sdk`

- Client TS (Node/web) via `isomorphic-ws`:
  - connexion WS + reconnect exponentiel avec jitter
  - `publish`, `subscribe`, `rpc`, `getState`, `setState`, `patchState`, `watchState`
  - correlation RPC + timeout
  - emission presence automatique

### 1.5 Deployment/ops

- Configuration hub:
  - `hub.config.ts`
  - `hub.config.json`
- Reverse proxy local:
  - `deploy/Caddyfile`
- Exemples fournis:
  - `examples/music-provider.ts`
  - `examples/music-controller.ts`
- Documentation de base:
  - `README.md`

## 2. Problemes rencontres et corrections appliquees

- Erreurs TS initiales (imports/types/rferences workspace): corrigees.
- Incompatibilite ESM/CJS `fast-json-patch`: corrigee.
- Chargement config selon `cwd` (paths console/apps/sqlite): corrige via normalisation robuste.
- Allowlist IP refusant `127.0.0.1` a tort: corrige (import `ipaddr.js` ESM + normalisation IP).
- Console blanche/500 intermittents:
  - serving static console rendu plus defensif
  - strategie unique de chargement JS inline dans `index.html`
  - fallback UX explicite en cas de token invalide / allowlist refusee
  - headers `Cache-Control: no-store` pour limiter les artefacts cache

## 3. Validation effectuee

- `npm run typecheck`: OK
- `npm run build`: OK
- `npm test`: socle de tests ajoute (unit + integration).\
  Note: les tests integration WS ouvrent un port local et peuvent echouer en environnement sandbox restreint.
- Tests manuels confirmes:
  - exemples `music-provider` / `music-controller` fonctionnels
  - console accessible et chargee en local

## 4. Etat par rapport a la spec initiale

Notation:
- `DONE` = implemente
- `PARTIAL` = implemente en partie
- `TODO` = non implemente

### 4.1 MVP

- Caddy + TLS local: `PARTIAL`
  - `Caddyfile` fourni, mais installation CA/trust iOS reste operationnelle a faire sur machine cible.
- Hub WS + registry + pub/sub: `DONE`
- SDK TS minimal: `DONE`
- Console services + inspector simple: `DONE`

### 4.2 V1

- RPC: `DONE`
  - Hub route `rpc_req/rpc_res` et endpoint HTTP RPC OK.
  - SDK provider complete avec `onRpc(method, handler)` + reponse `rpc_res` automatique.
- State + watch (patch): `DONE`
- Token + pairing page: `DONE`
  - QR code reel + fallback si dependance indisponible
- Metrics basiques: `DONE`
- Persistance SQLite snapshots: `DONE`

### 4.3 V1.1

- Hosting `/apps/*`: `DONE` (base statique)
- Export/import config: `TODO`
- Traces/correlation UX: `TODO`

## 5. Reste a faire (priorise)

### P0 - a faire en premier

1. Completer le flux RPC cote SDK provider: `DONE`
- API SDK ajoutee pour gerer `rpc_req` et renvoyer `rpc_res` simplement (`onRpc`).
- Exemples `music` migrés vers une vraie RPC bidirectionnelle.

2. Ajouter tests automatiques: `DONE`
- Tests unitaires: validation contrats, router, state store, allowlist, backpressure.
- Tests integration: WS multi-clients, reconnect, rpc timeout, state watch.

3. Durcir l'observabilite runtime: `DONE`
- Endpoint/commande de diagnostic rapide (version config effective + etat routing).
- Logs d'erreurs structurees pour toutes branches critiques.

### P1 - important

4. Pairing QR reel: `DONE`
- QR code genere sur `/console/pair` avec payload JSON `url+token`.

5. Nettoyage console: `DONE`
- Une seule strategie de chargement JS inline (plus de dependance au fetch `app.js`).
- Banner d'erreur clair pour token invalide / IP non allowlist.

6. Docs ops complete: `DONE`
- Runbook `docs/OPS_RUNBOOK.md`:
  - trust CA macOS+iOS pas-a-pas
  - supervision/restart launchd + option PM2

### P2 - evolution

7. Export/import config
8. UX de correlation/traces
9. Predicate de subscription (V2)
10. Rotation de token / pairing avance (V2)

## 6. Check-list de mise en prod LAN

1. Verifier DNS local `hub.local` resolu pour tous clients LAN.
2. Activer Caddy TLS et confiance CA sur macOS + iOS.
3. Definir token robuste (`HUB_TOKEN`) et retirer valeurs par defaut.
4. Verifier `allowlistSubnets` (eviter `*` hors debug).
5. Activer persistance + retention audit adaptee.
6. Lancer smoke tests:
   - `GET /api/health`
   - connexion WS
   - publish/subscribe
   - RPC
   - state watch

## 7. Notes importantes

- La stack est fonctionnelle pour dev local et experimentation LAN.
- Les chantiers restants sont de niveau V1.1/P2 (export/import config, traces UX, rotation token avancee).
