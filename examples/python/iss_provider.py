# iss_provider.py
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
    tls_context_for_url,
    ws_url_with_token,
)


def as_dict(value: object) -> dict:
    return value if isinstance(value, dict) else {}


async def run() -> None:
    token = os.getenv("HUB_TOKEN")
    client_id = os.getenv("CLIENT_ID") or f"py-iss-provider-{now_ms()}"

    http_url = default_http_url()
    ws_url = ws_url_with_token(default_ws_url(http_url), token)
    source = {"clientId": client_id, "serviceName": "iss"}

    async with websockets.connect(
        ws_url,
        ping_interval=20,
        ping_timeout=20,
        max_size=1024 * 1024,
        ssl=tls_context_for_url(ws_url),
    ) as ws:
        print(f"iss-provider connected ({client_id}) -> {ws_url}")

        await send_json(
            ws,
            make_presence_envelope(
                client_id=client_id,
                service_name="iss",
                version="0.1.0",
                provides=["iss.*"],
                consumes=["iss.*"],
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

            await send_json(
                ws,
                make_envelope(
                    msg_type="rpc_res",
                    name=name if isinstance(name, str) else "rpc",
                    source=source,
                    target={"serviceName": "hub"},
                    schema_version=1,
                    correlation_id=correlation_id,
                    payload={
                        "ok": False,
                        "error": {
                            "code": "NOT_IMPLEMENTED",
                            "message": f"iss-provider placeholder: no handler for {method}",
                        },
                    },
                ),
            )


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("iss-provider stopped")


if __name__ == "__main__":
    main()
