# Examples - Dev Guide

Ce dossier contient des exemples Node.js/TS et Python pour valider le flux SuperHub en local:

- `music-provider.ts`: service provider `music`
- `music-controller.ts`: client controller qui appelle une RPC `music.play`
- `iss-monitor.ts`: client Node/TS qui affiche en temps reel `iss.position`
- `python/`: memes flux en Python (WS + HTTP), voir `examples/python/README.md`
  - `iss_provider.py`: provider ISS minimal
  - `iss_updater.py`: updater ISS (frequence reglable 1..50 Hz)

## Prerequis

- Dependances installees a la racine:

```bash
npm install
```

- Hub demarre dans un terminal:

```bash
npm run dev
```

- Token de test configure (si `security.token` est active):
  - valeur par defaut dans ce repo: `CHANGE_ME_SUPERHUB_TOKEN`

## Execution rapide

Depuis la racine du repo (`/Users/olivierveinand/Documents/DEV/SuperHub`):

Preparation `.env` examples:

```bash
cp examples/.env.example examples/.env
set -a
source examples/.env
set +a
```

Terminal 1 (Hub):

```bash
npm run dev
```

Terminal 2 (Provider):

```bash
HUB_TOKEN=CHANGE_ME_SUPERHUB_TOKEN \
HUB_TLS_CA_FILE="$HOME/Library/Application Support/Caddy/pki/authorities/local/root.crt" \
npx tsx examples/music-provider.ts
```

Terminal 3 (Controller):

```bash
HUB_TOKEN=CHANGE_ME_SUPERHUB_TOKEN \
HUB_TLS_CA_FILE="$HOME/Library/Application Support/Caddy/pki/authorities/local/root.crt" \
npx tsx examples/music-controller.ts
```

Terminal 4 (ISS monitor Node/TS):

```bash
HUB_TOKEN=CHANGE_ME_SUPERHUB_TOKEN \
HUB_TLS_CA_FILE="$HOME/Library/Application Support/Caddy/pki/authorities/local/root.crt" \
npx tsx examples/iss-monitor.ts
```

## Ce qui doit se passer

- Le provider loggue sa connexion.
- Le controller loggue sa connexion.
- Le controller envoie une RPC `music.play`.
- Le provider traite la RPC via `onRpc("music.play", ...)`.
- Le controller recoit une `rpc_res` avec `accepted: true`.
- Un evenement `music.played` est publie.
- Le state `state/music/current` est mis a jour.

## Flux ISS en temps reel (Python -> Node/TS)

Dans `examples/python` lance `iss_updater.py`, puis lance `examples/iss-monitor.ts`.

Le monitor Node affiche:
- les events `iss.position`
- les updates state `state/iss/position`

## URL utilisee par les exemples

Les exemples sont configures pour parler au Hub local via Caddy/TLS:

- `https://mac-mini-de-olivier.local`

Tu peux override avec `HUB_HTTP_URL` si besoin (par exemple `http://127.0.0.1:7777` sans Caddy).

Variables TLS utiles (Node examples):
- `HUB_TLS_CA_FILE`: chemin du `root.crt` Caddy local (recommande)
- `HUB_TLS_INSECURE=1`: desactive la verification TLS (dev only)

Note: les exemples Node detectent automatiquement le CA Caddy a
`~/Library/Application Support/Caddy/pki/authorities/local/root.crt` si present.

## Troubleshooting

- `FORBIDDEN / IP is not allowlisted`:
  - verifie `security.allowlistSubnets` dans `hub.config.json`
- `AUTH_REQUIRED`:
  - verifie `HUB_TOKEN`
- Pas de message recu:
  - verifie que le Hub tourne
  - verifie que provider et controller utilisent la meme URL (`HUB_HTTP_URL`) et le meme token
- Certificat/TLS navigateur iOS/macOS:
  - voir setup Caddy + trust CA dans la doc racine
- `unable to get local issuer certificate` (Node):
  - set `HUB_TLS_CA_FILE="$HOME/Library/Application Support/Caddy/pki/authorities/local/root.crt"`
  - sinon fallback dev: `HUB_TLS_INSECURE=1`

## Tests associes

Les tests integration couvrent ce flux (pub/sub, rpc timeout, state watch):

```bash
npm test
```
