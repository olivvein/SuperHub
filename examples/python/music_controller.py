from __future__ import annotations

import asyncio
import os
import time

import websockets

from hub_protocol import (
    decode_json,
    default_http_url,
    default_ws_url,
    make_envelope,
    make_presence_envelope,
    new_id,
    now_ms,
    send_json,
    ws_url_with_token,
)


def as_dict(value: object) -> dict:
    return value if isinstance(value, dict) else {}


async def run() -> None:
    token = os.getenv("HUB_TOKEN")
    client_id = os.getenv("CLIENT_ID") or f"py-music-controller-{now_ms()}"

    http_url = default_http_url()
    ws_url = ws_url_with_token(default_ws_url(http_url), token)
    source = {"clientId": client_id, "serviceName": "music-controller"}

    subscribe_id = new_id()
    watch_id = new_id()
    correlation_id = new_id()

    async with websockets.connect(ws_url, ping_interval=20, ping_timeout=20, max_size=1024 * 1024) as ws:
        print(f"music-controller connected ({client_id}) -> {ws_url}")

        await send_json(
            ws,
            make_presence_envelope(
                client_id=client_id,
                service_name="music-controller",
                version="0.1.0",
                provides=[],
                consumes=["music.*"],
                tags=["example", "python", "controller"],
            ),
        )

        await send_json(
            ws,
            make_envelope(
                msg_type="cmd",
                name="subscribe",
                source=source,
                target={"serviceName": "hub"},
                schema_version=1,
                payload={"subscriptionId": subscribe_id, "namePrefix": "music."},
            ),
        )

        await send_json(
            ws,
            make_envelope(
                msg_type="cmd",
                name="state_watch",
                source=source,
                target={"serviceName": "hub"},
                schema_version=1,
                payload={"watchId": watch_id, "prefix": "state/music"},
            ),
        )

        await send_json(
            ws,
            make_envelope(
                msg_type="rpc_req",
                name="music.play",
                source=source,
                target={"serviceName": "music"},
                schema_version=1,
                correlation_id=correlation_id,
                payload={
                    "method": "music.play",
                    "args": {"trackId": "track-42", "positionMs": 0},
                    "timeoutMs": 5000,
                },
            ),
        )

        print("rpc music.play sent, waiting for events/state/rpc...")
        rpc_received = False
        listen_until = time.monotonic() + 15

        while time.monotonic() < listen_until:
            timeout = max(0.1, listen_until - time.monotonic())
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
            except asyncio.TimeoutError:
                break

            message = decode_json(raw)
            msg_type = message.get("type")
            name = message.get("name")

            if msg_type == "error":
                print("hub error", message.get("payload"))
                continue

            if msg_type == "event" and isinstance(name, str) and name.startswith("music."):
                print("event", name, message.get("payload"))
                continue

            if msg_type == "state_patch":
                payload = as_dict(message.get("payload"))
                print("state patch", payload.get("path"), payload.get("value"))
                continue

            if msg_type == "rpc_res" and message.get("correlationId") == correlation_id:
                print("rpc response", message.get("payload"))
                rpc_received = True

                await send_json(
                    ws,
                    make_envelope(
                        msg_type="cmd",
                        name="state_set",
                        source=source,
                        target={"serviceName": "hub"},
                        schema_version=1,
                        payload={
                            "path": "state/music/current",
                            "value": {"trackId": "track-42", "startedAt": now_ms()},
                        },
                    ),
                )
                listen_until = time.monotonic() + 5

        if not rpc_received:
            print("No rpc_res received within timeout.")

        await send_json(
            ws,
            make_envelope(
                msg_type="cmd",
                name="unsubscribe",
                source=source,
                target={"serviceName": "hub"},
                schema_version=1,
                payload={"subscriptionId": subscribe_id},
            ),
        )

        await send_json(
            ws,
            make_envelope(
                msg_type="cmd",
                name="state_unwatch",
                source=source,
                target={"serviceName": "hub"},
                schema_version=1,
                payload={"watchId": watch_id},
            ),
        )

        print("music-controller done")


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("music-controller stopped")


if __name__ == "__main__":
    main()
