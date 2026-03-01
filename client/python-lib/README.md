# superhub-client (Python)

Python client library for SuperHub over WS/HTTP.

## Quick use

```python
import asyncio
from superhub_client import SuperHubClient

async def main() -> None:
    client = SuperHubClient(token="CHANGE_ME_SUPERHUB_TOKEN", service_name="py-demo")
    await client.connect()
    await client.publish("demo.ping", {"ok": True})
    await client.close()

asyncio.run(main())
```

## Bundled examples (installed with the package)

The package now includes all examples under `superhub_client.examples`:

- `music_provider`
- `music_controller`
- `iss_provider`
- `iss_updater`
- `http_api_demo`

Run from repo root (dev mode):

```bash
# optional: load env template
cp client/python-lib/examples/.env.example client/python-lib/examples/.env
set -a
source client/python-lib/examples/.env
set +a

# install package in editable mode
pip install -e client/python-lib

# optional dependency for updater
pip install "client/python-lib[examples]"

# or from installed package using CLI entry points
superhub-py-music-provider
superhub-py-music-controller
superhub-py-iss-provider
superhub-py-http-demo
superhub-py-iss-updater --hz 10

# same examples via python -m
python -m superhub_client.examples.music_provider
python -m superhub_client.examples.music_controller
python -m superhub_client.examples.iss_provider
python -m superhub_client.examples.http_api_demo
python -m superhub_client.examples.iss_updater --hz 10
```

ISS updater TLE source overrides:

```bash
ISS_TLE_URLS="https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle,https://celestrak.org/NORAD/elements/stations.txt"
ISS_TLE_CACHE_FILE="$HOME/.superhub/iss_tle.txt"
```
