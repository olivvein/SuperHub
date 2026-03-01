# Examples - Dev Guide

Ce dossier contient 2 exemples Node.js/TS pour valider le flux SuperHub en local:

- `music-provider.ts`: service provider `music`
- `music-controller.ts`: client controller qui appelle une RPC `music.play`
- `python/`: memes flux en Python (WS + HTTP), voir `examples/python/README.md`

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

Terminal 1 (Hub):

```bash
npm run dev
```

Terminal 2 (Provider):

```bash
HUB_TOKEN=CHANGE_ME_SUPERHUB_TOKEN npx tsx examples/music-provider.ts
```

Terminal 3 (Controller):

```bash
HUB_TOKEN=CHANGE_ME_SUPERHUB_TOKEN npx tsx examples/music-controller.ts
```

## Ce qui doit se passer

- Le provider loggue sa connexion.
- Le controller loggue sa connexion.
- Le controller envoie une RPC `music.play`.
- Le provider traite la RPC via `onRpc("music.play", ...)`.
- Le controller recoit une `rpc_res` avec `accepted: true`.
- Un evenement `music.played` est publie.
- Le state `state/music/current` est mis a jour.

## URL utilisee par les exemples

Les exemples sont configures pour parler au Hub local HTTP:

- `http://127.0.0.1:7777`

Si tu passes en TLS via Caddy (`https://hub.local`), mets a jour `httpUrl` dans les exemples.

## Troubleshooting

- `FORBIDDEN / IP is not allowlisted`:
  - verifie `security.allowlistSubnets` dans `hub.config.json`
- `AUTH_REQUIRED`:
  - verifie `HUB_TOKEN`
- Pas de message recu:
  - verifie que le Hub tourne
  - verifie que provider et controller utilisent la meme URL et le meme token
- Certificat/TLS navigateur iOS/macOS:
  - voir setup Caddy + trust CA dans la doc racine

## Tests associes

Les tests integration couvrent ce flux (pub/sub, rpc timeout, state watch):

```bash
npm test
```
