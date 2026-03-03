# Python Examples

Python examples for SuperHub protocol usage over WS and HTTP.

## Files

- `music_provider.py`: WS provider for service `music` (handles `music.play` RPC).
- `music_controller.py`: WS client that subscribes, watches state, and sends `music.play` RPC.
- `iss_provider.py`: WS provider `iss` (stub RPC responder).
- `iss_updater.py`: realtime ISS updater (state + event push).
- `http_api_demo.py`: HTTP API demo (`/api/health`, `/api/publish`, `/api/rpc`).
- `hub_protocol.py`: shared helpers for envelope creation and URLs.

## Prerequisites

- Python 3.10+
- Hub running locally:

```bash
npm run dev
```

- Token in env if security token is enabled:
  - default in this repo: `CHANGE_ME_SUPERHUB_TOKEN`

## Install

From repo root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r examples/python/requirements.txt
```

## Quick start

Terminal 1 (provider):

```bash
source .venv/bin/activate
HUB_TOKEN=CHANGE_ME_SUPERHUB_TOKEN \
HUB_TLS_CA_FILE="$HOME/Library/Application Support/Caddy/pki/authorities/local/root.crt" \
python examples/python/music_provider.py
```

Terminal 2 (controller):

```bash
source .venv/bin/activate
HUB_TOKEN=CHANGE_ME_SUPERHUB_TOKEN \
HUB_TLS_CA_FILE="$HOME/Library/Application Support/Caddy/pki/authorities/local/root.crt" \
python examples/python/music_controller.py
```

You should see:
- provider receives `rpc_req` for `music.play`
- controller receives `rpc_res`
- `music.played` event
- `state_patch` for `state/music/current`

## HTTP demo

Run with provider active to see RPC success:

```bash
source .venv/bin/activate
HUB_TOKEN=CHANGE_ME_SUPERHUB_TOKEN python examples/python/http_api_demo.py
```

## Environment variables

- `HUB_HTTP_URL` (default: `https://mac-mini-de-olivier.local`)
- `HUB_WS_URL` (optional; auto-derived from `HUB_HTTP_URL`)
- `HUB_TOKEN` (optional if hub has no token)
- `CLIENT_ID` (optional; auto-generated if missing)
- `ISS_SEND_HZ` (for `iss_updater.py`, default `1`, clamped to `1..50`)
- `HUB_TLS_CA_FILE` (recommended for local TLS CA, e.g. Caddy `root.crt`)
- `HUB_TLS_INSECURE=1` (dev-only: disable TLS verification)

Python examples also auto-detect Caddy CA at:
- `~/Library/Application Support/Caddy/pki/authorities/local/root.crt`

## ISS updater rate

`iss_updater.py` send rate is adjustable from `1` to `50` Hz:

```bash
# via env
ISS_SEND_HZ=20 HUB_TOKEN=CHANGE_ME_SUPERHUB_TOKEN python examples/python/iss_updater.py

# via CLI (priority over env)
HUB_TOKEN=CHANGE_ME_SUPERHUB_TOKEN python examples/python/iss_updater.py --hz 50
```

## ISS quick start

```bash
# terminal 1
HUB_TOKEN=CHANGE_ME_SUPERHUB_TOKEN \
HUB_TLS_CA_FILE="$HOME/Library/Application Support/Caddy/pki/authorities/local/root.crt" \
python examples/python/iss_provider.py

# terminal 2
HUB_TOKEN=CHANGE_ME_SUPERHUB_TOKEN \
HUB_TLS_CA_FILE="$HOME/Library/Application Support/Caddy/pki/authorities/local/root.crt" \
python examples/python/iss_updater.py --hz 10
```

Published by updater:
- state path: `state/iss/position`
- event name: `iss.position`

## Notes

- WS auth uses `?token=` query param (compatible with current hub auth).
- For TLS/local domain usage, set:
  - `HUB_HTTP_URL=https://mac-mini-de-olivier.local`
  - `HUB_TLS_CA_FILE=$HOME/Library/Application Support/Caddy/pki/authorities/local/root.crt`
  - trust CA first (`docs/OPS_RUNBOOK.md`).
