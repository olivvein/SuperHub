from __future__ import annotations

import asyncio
import os
from typing import Any

from superhub_client import SuperHubClient, now_ms


async def run() -> None:
    client = SuperHubClient(
        token=os.getenv("HUB_TOKEN"),
        client_id=os.getenv("CLIENT_ID") or f"py-music-provider-{now_ms()}",
        service_name="music",
        version="0.1.0",
        provides=["music.play", "music.pause", "music.next"],
        consumes=["music.*"],
        tags=["example", "python-lib", "provider"],
    )

    client.add_open_listener(lambda: print("music-provider connected"))
    client.add_close_listener(lambda: print("music-provider disconnected"))
    client.add_error_listener(lambda error: print("hub error", error))

    async def on_music_play(args: Any, _ctx: dict[str, Any]) -> dict[str, Any]:
        input_data = args if isinstance(args, dict) else {}
        track_id = input_data.get("trackId") if isinstance(input_data.get("trackId"), str) else "unknown-track"
        position_ms = input_data.get("positionMs") if isinstance(input_data.get("positionMs"), int) else 0

        print("rpc music.play", {"trackId": track_id, "positionMs": position_ms})

        await client.set_state(
            "state/music/current",
            {
                "trackId": track_id,
                "positionMs": position_ms,
                "startedAt": now_ms(),
            },
        )

        await client.publish("music.played", {"trackId": track_id, "at": now_ms()})

        return {
            "accepted": True,
            "trackId": track_id,
            "positionMs": position_ms,
        }

    client.on_rpc("music.play", on_music_play)
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
        print("music-provider stopped")


if __name__ == "__main__":
    main()
