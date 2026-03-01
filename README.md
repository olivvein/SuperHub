# SuperHub

Hub local HTTPS/WSS pour projets perso (Mac mini, Node.js/TypeScript).

## Documentation de suivi

- Statut implementation + reste a faire: `docs/IMPLEMENTATION_STATUS.md`

## Ce qui est inclus

- `@superhub/hub`:
  - endpoint WS `/ws` + API `/api/*`
  - registry clients/services + health
  - pub/sub + routage ciblé
  - RPC léger (`rpc_req` / `rpc_res`)
  - state store (`state_set`, `state_patch`, `state_get`, `state_watch`)
  - sécurité LAN minimale (`X-Hub-Token`, allowlist subnet, rate/size limits)
  - métriques + inspector
  - console web servie sous `/console`
  - persistance SQLite optionnelle
- `@superhub/sdk`:
  - client TS (Node + web) avec reconnect/backoff
  - `publish`, `subscribe`, `rpc`, `getState`, `setState`, `patchState`, `watchState`
- `@superhub/contracts`:
  - envelope unique + schémas Zod + validation versionnée
- `deploy/Caddyfile`:
  - terminaison TLS locale + reverse proxy vers le Hub

## Arborescence

- `/packages/contracts`
- `/packages/sdk`
- `/packages/hub`
- `/examples`
- `/deploy/Caddyfile`
- `/hub.config.ts`

## Démarrage local

1. Installer les dépendances:

```bash
npm install
```

2. Préparer la config:

```bash
cp .env.example .env
```

3. Lancer le Hub (HTTP local sur `127.0.0.1:7777`):

```bash
npm run dev
```

4. Ouvrir la console:

- en direct: `http://127.0.0.1:7777/console/`
- via Caddy/TLS: `https://hub.local/console/`

## Caddy + TLS local (LAN)

1. Installer et lancer Caddy avec `deploy/Caddyfile`.
2. Ajouter `hub.local` au DNS local (ou `/etc/hosts` pour tests).
3. Faire confiance à la CA locale Caddy sur macOS et iOS.
4. Vérifier:
   - `https://hub.local/api/health`
   - `wss://hub.local/ws`

## API HTTP

- `GET /api/health`
- `GET /api/services`
- `GET /api/clients`
- `GET /api/topics`
- `GET /api/messages`
- `GET /api/state?path=...` ou `GET /api/state?prefix=...`
- `GET /api/config`
- `GET /api/metrics`
- `POST /api/publish`
- `POST /api/rpc`

`X-Hub-Token` requis si `security.token` est configuré (sauf `/api/health`).

## WS protocol

Tous les messages utilisent l’envelope `HubEnvelope` (version `v=1`) avec `type`:

- `event`
- `cmd`
- `rpc_req`
- `rpc_res`
- `state_patch`
- `presence`
- `error`

## Exemples

- Provider music: `examples/music-provider.ts`
- Controller: `examples/music-controller.ts`

Lancer via `tsx` (après `npm install`):

```bash
npx tsx examples/music-provider.ts
npx tsx examples/music-controller.ts
```

## Notes V1

- Delivery pub/sub en best-effort, ordre global non garanti.
- Backpressure par session: buffer borné + drop quand surcharge.
- Validation Zod par `name` + `schemaVersion`:
  - `reject` en dev par défaut
  - `warn` possible en prod
