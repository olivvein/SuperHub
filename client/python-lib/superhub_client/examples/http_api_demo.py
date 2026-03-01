from __future__ import annotations

import json
import os

from superhub_client import HubHttpClient, now_ms


def main() -> None:
    token = os.getenv("HUB_TOKEN")
    client = HubHttpClient(token=token)

    print("base_url:", client.base_url)
    print("health:", json.dumps(client.health(), indent=2))

    if token:
        print("services:", json.dumps(client.services(), indent=2))
    else:
        print("HUB_TOKEN not set, /api/services will likely require auth.")

    publish_result = client.publish(
        name="notes.updated",
        payload={
            "noteId": "note-python-demo",
            "updatedAt": now_ms(),
        },
    )
    print("publish:", json.dumps(publish_result, indent=2))

    rpc_result = client.rpc(
        service_name="music",
        method="music.play",
        args={"trackId": "track-http-1", "positionMs": 0},
        timeout_ms=5000,
    )
    print("rpc:", json.dumps(rpc_result, indent=2))


if __name__ == "__main__":
    main()
