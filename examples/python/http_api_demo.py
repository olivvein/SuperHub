from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

from hub_protocol import default_http_url, now_ms, tls_context_for_url


def request_json(
    *,
    base_url: str,
    method: str,
    path: str,
    token: str | None = None,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    url = f"{base_url}{path}"
    payload = None
    if body is not None:
        payload = json.dumps(body).encode("utf-8")

    request = urllib.request.Request(url=url, method=method, data=payload)
    request.add_header("Accept", "application/json")
    if body is not None:
        request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("X-Hub-Token", token)

    ssl_context = tls_context_for_url(base_url)

    try:
        with urllib.request.urlopen(request, timeout=10, context=ssl_context) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw)
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code} {path}: {raw}") from error


def main() -> None:
    base_url = default_http_url()
    token = os.getenv("HUB_TOKEN")
    print("Base URL:", base_url)

    health = request_json(base_url=base_url, method="GET", path="/api/health")
    print("health:", json.dumps(health, indent=2))

    if token:
        services = request_json(base_url=base_url, method="GET", path="/api/services", token=token)
        print("services:", json.dumps(services, indent=2))
    else:
        print("HUB_TOKEN not set, skipping /api/services call.")

    publish_response = request_json(
        base_url=base_url,
        method="POST",
        path="/api/publish",
        token=token,
        body={
            "name": "notes.updated",
            "type": "event",
            "target": "*",
            "schemaVersion": 1,
            "payload": {
                "noteId": "note-python-demo",
                "updatedAt": now_ms(),
            },
        },
    )
    print("publish:", json.dumps(publish_response, indent=2))

    rpc_response = request_json(
        base_url=base_url,
        method="POST",
        path="/api/rpc",
        token=token,
        body={
            "serviceName": "music",
            "method": "music.play",
            "args": {"trackId": "track-http-1", "positionMs": 0},
            "timeoutMs": 5000,
        },
    )
    print("rpc:", json.dumps(rpc_response, indent=2))


if __name__ == "__main__":
    main()
