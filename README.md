# SuperHub

Hub local HTTPS/WSS pour projets perso (Mac mini, Node.js/TypeScript).

## Documentation de suivi

- Statut implementation + reste a faire: `docs/IMPLEMENTATION_STATUS.md`
- Runbook ops (TLS local, trust iOS/macOS, supervision): `docs/OPS_RUNBOOK.md`
- Guide dev exemples music: `examples/README.md`
- Guide dev exemples Python: `examples/python/README.md`
- Guide clients (Node/TS, Python, React): `client/README.md`

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
  - flux dashboard realtime WS (`hub.dashboard`) + fallback HTTP
  - persistance SQLite optionnelle
- `@superhub/sdk`:
  - client TS (Node + web) avec reconnect/backoff
  - `publish`, `subscribe`, `rpc`, `onRpc`, `getState`, `setState`, `patchState`, `watchState`
- `@superhub/contracts`:
  - envelope unique + schémas Zod + validation versionnée
- `deploy/Caddyfile`:
  - terminaison TLS locale + reverse proxy vers le Hub

## Arborescence

- `/packages/contracts`
- `/packages/sdk`
- `/packages/hub`
- `/examples`
- `/client`
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
- via Caddy/TLS: `https://macbook-pro-de-olivier.local/console/`
- pairing: `https://macbook-pro-de-olivier.local/console/pair`
- dashboard realtime: WS interne auto (`/ws`) + fallback poll 5s

## Caddy + TLS local (LAN)

1. Installer et lancer Caddy avec `deploy/Caddyfile`.
2. Ajouter `macbook-pro-de-olivier.local` au DNS local (ou `/etc/hosts` pour tests).
3. Faire confiance à la CA locale Caddy sur macOS et iOS.
4. Vérifier:
   - `https://macbook-pro-de-olivier.local/api/health`
   - `wss://macbook-pro-de-olivier.local/ws`

Procedure complete detaillee: `docs/OPS_RUNBOOK.md`.

## API HTTP

- `GET /api/health`
- `GET /api/services`
- `GET /api/clients`
- `GET /api/topics`
- `GET /api/messages`
- `GET /api/state?path=...` ou `GET /api/state?prefix=...`
- `GET /api/config`
- `GET /api/metrics`
- `GET /api/diagnostics`
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
- Python: `examples/python/` (music + ISS + demo HTTP)

Lancer via `tsx` (après `npm install`):

```bash
npx tsx examples/music-provider.ts
npx tsx examples/music-controller.ts
```

Le flux `music` d'exemple est maintenant base sur une vraie RPC:
- `music-controller` envoie `rpc(\"music\", \"music.play\", ...)`
- `music-provider` repond via `onRpc(\"music.play\", handler)`

## Outils ops

Tests:

```bash
npm test
```

Diagnostics runtime:

```bash
HUB_TOKEN=... npm run diag
```

Distribution clients LAN (sans npm/pip publish):

```bash
npm run client:dist
```

## Notes V1

- Delivery pub/sub en best-effort, ordre global non garanti.
- Backpressure par session: buffer borné + drop quand surcharge.
- Optimisation flux haute fréquence:
  - sérialisation WS mutualisée pour broadcasts
  - snapshots state SQLite coalescés (flush périodique) au lieu d'un write par update
  - rate limit token-bucket + `rateLimitPerMinute` par défaut à `120000` (`0` pour désactiver)
- Console:
  - state viewer realtime via `state_patch` WS
  - dashboard realtime via event `hub.dashboard` WS
  - fallback HTTP periodique si WS indisponible
- Validation Zod par `name` + `schemaVersion`:
  - `reject` en dev par défaut
  - `warn` possible en prod
