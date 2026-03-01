from __future__ import annotations

import asyncio
import os
import pathlib
import sys
from typing import Any

try:
    from superhub_client import SuperHubClient, now_ms
except ImportError:
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
    from superhub_client import SuperHubClient, now_ms


async def run() -> None:
    started_at = now_ms()
    client = SuperHubClient(
        token=os.getenv("HUB_TOKEN"),
        client_id=os.getenv("CLIENT_ID") or f"py-iss-provider-{now_ms()}",
        service_name="iss",
        version="0.1.0",
        provides=["iss.*"],
        consumes=["iss.*"],
        tags=["example", "python-lib", "provider"],
    )

    client.add_open_listener(lambda: print("iss-provider connected"))
    client.add_close_listener(lambda: print("iss-provider disconnected"))
    client.add_error_listener(lambda error: print("hub error", error))

    def handle_health(_args: Any, _ctx: dict[str, Any]) -> dict[str, Any]:
        return {
            "ok": True,
            "service": "iss",
            "uptimeMs": now_ms() - started_at,
        }

    client.on_rpc("iss.health", handle_health)
    await client.connect()

    stop = asyncio.Event()
    try:
        await stop.wait()
    finally:
        await client.close()


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("iss-provider stopped")


if __name__ == "__main__":
    main()
