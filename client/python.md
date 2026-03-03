# Python Client Guide

This guide is for Python projects using the `superhub-client` package.

## 1) Install (no PyPI)

Install from LAN artifact:

```bash
pip install --extra-index-url "https://mac-mini-de-olivier.local/apps/client/dist/python/simple/" superhub-client
```

Or install from local SuperHub checkout:

```bash
pip install -e /path/to/SuperHub/client/python-lib
```

If pip fails on local TLS cert:

```bash
curl -k "https://mac-mini-de-olivier.local/apps/client/dist/certs/caddy-local-root.crt" -o "$HOME/.superhub-caddy-root.crt"
PIP_CERT="$HOME/.superhub-caddy-root.crt" pip install --extra-index-url "https://mac-mini-de-olivier.local/apps/client/dist/python/simple/" superhub-client
```

Optional env template for ISS examples:

```bash
cp /path/to/SuperHub/client/python-lib/examples/.env.example /path/to/SuperHub/client/python-lib/examples/.env
set -a
source /path/to/SuperHub/client/python-lib/examples/.env
set +a
```

## 2) Minimal WS Client

```python
from __future__ import annotations

import asyncio
import os

from superhub_client import SuperHubClient


async def main() -> None:
    client = SuperHubClient(
        token=os.getenv("HUB_TOKEN"),
        service_name="py-demo",
        consumes=["music.*"],
    )

    client.add_open_listener(lambda: print("connected"))
    client.add_error_listener(lambda err: print("hub error", err))
    client.add_close_listener(lambda: print("closed"))

    await client.connect()

    unsubscribe = await client.subscribe(
        name_prefix="music.",
        handler=lambda message: print("event", message.get("name"), message.get("payload")),
    )

    result = await client.rpc("music", "music.play", {"trackId": "py-track-1", "positionMs": 0}, timeout_ms=5000)
    print("rpc result", result)

    await client.publish("demo.ping", {"at": "now"})
    await client.set_state("state/demo/lastPing", {"ok": True})

    await asyncio.sleep(3)
    await unsubscribe()
    await client.close()


asyncio.run(main())
```

## 3) Minimal HTTP Client

```python
import os

from superhub_client import HubHttpClient

http = HubHttpClient(token=os.getenv("HUB_TOKEN"))
print(http.health())
print(http.services())
```

## 4) Useful Env Vars

- `HUB_HTTP_URL` default: `https://mac-mini-de-olivier.local`
- `HUB_WS_URL` optional explicit WS URL
- `HUB_TOKEN` shared token
- `HUB_TLS_CA_FILE` custom CA path
- `HUB_TLS_INSECURE=1` disable TLS verification (dev only)

## 5) Troubleshooting

- `ssl.SSLCertVerificationError`:
  - set `HUB_TLS_CA_FILE="$HOME/Library/Application Support/Caddy/pki/authorities/local/root.crt"`.
- auth errors:
  - verify `HUB_TOKEN` and allowlist.
- no events:
  - verify same hub URL/token across all clients.
- ISS updater exits with `HTTP Error 403` on Celestrak:
  - updater now retries across multiple HTTPS/HTTP TLE sources and uses local cache.
  - optional overrides:
  - `ISS_TLE_URLS="https://.../stations.txt,https://.../gp.php?..."`
  - `ISS_TLE_CACHE_FILE="$HOME/.superhub/iss_tle.txt"`

## 6) ISS examples in python-lib

- `client/python-lib/examples/iss_provider.py`
- `client/python-lib/examples/iss_updater.py`

`iss_updater.py` supports `--hz` (1..50) and `ISS_SEND_HZ`.

## 7) Bundled example commands (after pip install)

```bash
superhub-py-music-provider
superhub-py-music-controller
superhub-py-http-demo
superhub-py-iss-provider
superhub-py-iss-updater --hz 10
```

Equivalent module form:

```bash
python -m superhub_client.examples.music_provider
python -m superhub_client.examples.music_controller
python -m superhub_client.examples.http_api_demo
python -m superhub_client.examples.iss_provider
python -m superhub_client.examples.iss_updater --hz 10
```
