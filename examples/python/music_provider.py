from __future__ import annotations

import asyncio
import os

import websockets

from hub_protocol import (
    decode_json,
    default_http_url,
    default_ws_url,
    make_envelope,
    make_presence_envelope,
    now_ms,
    send_json,
    ws_url_with_token,
)


def as_dict(value: object) -> dict:
    return value if isinstance(value, dict) else {}


async def run() -> None:
    token = os.getenv("HUB_TOKEN")
    client_id = os.getenv("CLIENT_ID") or f"py-music-provider-{now_ms()}"

    http_url = default_http_url()
    ws_url = ws_url_with_token(default_ws_url(http_url), token)
    source = {"clientId": client_id, "serviceName": "music"}

    async with websockets.connect(ws_url, ping_interval=20, ping_timeout=20, max_size=1024 * 1024) as ws:
        print(f"music-provider connected ({client_id}) -> {ws_url}")

        await send_json(
            ws,
            make_presence_envelope(
                client_id=client_id,
                service_name="music",
                version="0.1.0",
                provides=["music.play", "music.pause", "music.next"],
                consumes=["music.*"],
                tags=["example", "python", "provider"],
            ),
        )

        async for raw in ws:
            message = decode_json(raw)
            msg_type = message.get("type")
            name = message.get("name")

            if msg_type == "error":
                print("hub error", message.get("payload"))
                continue

            if msg_type != "rpc_req":
                continue

            payload = as_dict(message.get("payload"))
            method = payload.get("method") if isinstance(payload.get("method"), str) else name
            correlation_id = message.get("correlationId") if isinstance(message.get("correlationId"), str) else None

            if not correlation_id:
                print("rpc_req ignored: missing correlationId", message)
                continue

            if method != "music.play":
                response = make_envelope(
                    msg_type="rpc_res",
                    name=name if isinstance(name, str) else "rpc",
                    source=source,
                    target={"serviceName": "hub"},
                    schema_version=1,
                    correlation_id=correlation_id,
                    payload={
                        "ok": False,
                        "error": {
                            "code": "METHOD_NOT_FOUND",
                            "message": f"No python handler for {method}",
                        },
                    },
                )
                await send_json(ws, response)
                continue

            args = as_dict(payload.get("args"))
            track_id = args.get("trackId") if isinstance(args.get("trackId"), str) else "unknown-track"
            position_ms = args.get("positionMs") if isinstance(args.get("positionMs"), int) else 0
            print("rpc music.play", {"trackId": track_id, "positionMs": position_ms})

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
                        "value": {
                            "trackId": track_id,
                            "positionMs": position_ms,
                            "startedAt": now_ms(),
                        },
                    },
                ),
            )

            await send_json(
                ws,
                make_envelope(
                    msg_type="event",
                    name="music.played",
                    source=source,
                    target="*",
                    schema_version=1,
                    payload={"trackId": track_id, "at": now_ms()},
                ),
            )

            await send_json(
                ws,
                make_envelope(
                    msg_type="rpc_res",
                    name=name if isinstance(name, str) else "music.play",
                    source=source,
                    target={"serviceName": "hub"},
                    schema_version=1,
                    correlation_id=correlation_id,
                    payload={
                        "ok": True,
                        "result": {
                            "accepted": True,
                            "trackId": track_id,
                            "positionMs": position_ms,
                        },
                    },
                ),
            )

            print("rpc_res sent", correlation_id)


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("music-provider stopped")


if __name__ == "__main__":
    main()
