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

## ISS examples

This package now includes ISS examples in `client/python-lib/examples/`:

- `iss_provider.py`
- `iss_updater.py`

Run from repo root:

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

# terminal 1
HUB_TOKEN=CHANGE_ME_SUPERHUB_TOKEN python client/python-lib/examples/iss_provider.py

# terminal 2
HUB_TOKEN=CHANGE_ME_SUPERHUB_TOKEN python client/python-lib/examples/iss_updater.py --hz 10
```
