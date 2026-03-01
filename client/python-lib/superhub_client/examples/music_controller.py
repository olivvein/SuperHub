from __future__ import annotations

import asyncio
import os

from superhub_client import SuperHubClient, now_ms


async def run() -> None:
    client = SuperHubClient(
        token=os.getenv("HUB_TOKEN"),
        client_id=os.getenv("CLIENT_ID") or f"py-music-controller-{now_ms()}",
        service_name="music-controller",
        version="0.1.0",
        provides=[],
        consumes=["music.*"],
        tags=["example", "python-lib", "controller"],
    )

    client.add_open_listener(lambda: print("music-controller connected"))
    client.add_close_listener(lambda: print("music-controller disconnected"))
    client.add_error_listener(lambda error: print("hub error", error))

    await client.connect()

    unsubscribe = await client.subscribe(
        name_prefix="music.",
        handler=lambda message: print("event", message.get("name"), message.get("payload")),
    )

    unwatch = await client.watch_state(
        "state/music",
        lambda path, value, _source: print("state patch", path, value),
    )

    response = await client.rpc("music", "music.play", {"trackId": "track-42", "positionMs": 0}, timeout_ms=5000)
    print("rpc response", response)

    await client.set_state("state/music/current", {"trackId": "track-42", "startedAt": now_ms()})
    await asyncio.sleep(5)

    await unsubscribe()
    await unwatch()
    await client.close()


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("music-controller stopped")


if __name__ == "__main__":
    main()
