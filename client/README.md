# SuperHub Client Docs

This folder contains practical client integration and distribution docs for:

- Node.js + TypeScript
- Python
- React (web)

Use these docs when building new apps that connect to SuperHub over HTTPS/WSS.

## Hub Defaults

- Base URL: `https://mac-mini-de-olivier.local`
- WebSocket endpoint: `wss://mac-mini-de-olivier.local/ws`
- HTTP API base: `https://mac-mini-de-olivier.local/api`
- Token header: `X-Hub-Token: <token>`
- WS auth: `?token=<token>`

## Security + TLS

- For browsers (React), trust the Caddy local CA on the OS/device.
- For Node/Python local scripts, use:
  - `HUB_TLS_CA_FILE="$HOME/Library/Application Support/Caddy/pki/authorities/local/root.crt"`
  - or `HUB_TLS_INSECURE=1` for local debug only.

## Guides

- Node/TS: `client/node-ts.md`
- Python: `client/python.md`
- React: `client/react.md`

## LAN Distribution (no npm/pip publish)

Build distributable artifacts:

```bash
npm run client:dist
```

This generates:

- `packages/hub/public/apps/client/dist/npm/superhub-sdk-latest.tgz`
- `packages/hub/public/apps/client/dist/python/superhub_client-<version>-py3-none-any.whl`
- `packages/hub/public/apps/client/dist/python/simple/superhub-client/index.html`
- `packages/hub/public/apps/client/dist/docs/index.html` (published Markdown bundle)
- `packages/hub/public/apps/client/dist/index.html`

With Hub + Caddy running, these files are available on LAN at:

- `https://mac-mini-de-olivier.local/apps/client/dist/`
- Docs bundle:
  - `https://mac-mini-de-olivier.local/apps/client/dist/docs/index.html`

Install from another computer:

```bash
# Node / React
npm install "https://mac-mini-de-olivier.local/apps/client/dist/npm/superhub-sdk-latest.tgz"

# Python
pip install --extra-index-url "https://mac-mini-de-olivier.local/apps/client/dist/python/simple/" superhub-client
```

If TLS CA is not trusted in CLI tools:

```bash
curl -k "https://mac-mini-de-olivier.local/apps/client/dist/certs/caddy-local-root.crt" -o "$HOME/.superhub-caddy-root.crt"
npm_config_cafile="$HOME/.superhub-caddy-root.crt" npm install "https://mac-mini-de-olivier.local/apps/client/dist/npm/superhub-sdk-latest.tgz"
PIP_CERT="$HOME/.superhub-caddy-root.crt" pip install --extra-index-url "https://mac-mini-de-olivier.local/apps/client/dist/python/simple/" superhub-client
```

## Examples included in libs

- Node/React (`@superhub/sdk`):
  - bundled at `@superhub/sdk/examples/`
  - scaffold into your project:

```bash
npx --no-install superhub-examples ./superhub-examples
```

- Python (`superhub-client`):
  - bundled as `superhub_client.examples.*`
  - runnable commands after install:

```bash
superhub-py-music-provider
superhub-py-music-controller
superhub-py-http-demo
superhub-py-iss-provider
superhub-py-iss-updater --hz 10
```
