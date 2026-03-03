from __future__ import annotations

import json
import os
import ssl
import time
import urllib.parse
import uuid
from typing import Any

HUB_PROTOCOL_VERSION = 1


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id() -> str:
    return str(uuid.uuid4())


def default_http_url() -> str:
    return os.getenv("HUB_HTTP_URL", "https://mac-mini-de-olivier.local").rstrip("/")


def default_ws_url(http_url: str) -> str:
    explicit = os.getenv("HUB_WS_URL")
    if explicit:
        return explicit.rstrip("/")
    return http_url.replace("https://", "wss://").replace("http://", "ws://").rstrip("/") + "/ws"


def tls_context_for_url(url: str) -> ssl.SSLContext | None:
    normalized = url.lower()
    if not (normalized.startswith("https://") or normalized.startswith("wss://")):
        return None

    insecure = os.getenv("HUB_TLS_INSECURE", "").strip().lower() in {"1", "true", "yes", "on"}
    if insecure:
        return ssl._create_unverified_context()

    default_caddy_ca = os.path.expanduser("~/Library/Application Support/Caddy/pki/authorities/local/root.crt")
    auto_ca_file = default_caddy_ca if os.path.exists(default_caddy_ca) else None
    ca_file = _resolve_ca_file(os.getenv("HUB_TLS_CA_FILE") or os.getenv("SSL_CERT_FILE")) or auto_ca_file
    if ca_file:
        return ssl.create_default_context(cafile=ca_file)

    return ssl.create_default_context()


def _resolve_ca_file(raw: str | None) -> str | None:
    if not raw:
        return None

    cleaned = raw.strip().strip('"').strip("'")
    expanded = os.path.expandvars(os.path.expanduser(cleaned))
    if os.path.exists(expanded):
        return expanded

    raise FileNotFoundError(
        f"TLS CA file not found: {raw} (expanded: {expanded}). "
        "Set HUB_TLS_CA_FILE to a valid absolute path."
    )


def ws_url_with_token(ws_url: str, token: str | None) -> str:
    if not token:
        return ws_url

    parsed = urllib.parse.urlparse(ws_url)
    params = [(key, value) for key, value in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True) if key != "token"]
    params.append(("token", token))
    query = urllib.parse.urlencode(params)
    return urllib.parse.urlunparse(parsed._replace(query=query))


def make_envelope(
    *,
    msg_type: str,
    name: str,
    source: dict[str, Any],
    target: dict[str, Any] | str,
    payload: Any,
    schema_version: int = 1,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    message = {
        "v": HUB_PROTOCOL_VERSION,
        "id": new_id(),
        "type": msg_type,
        "name": name,
        "source": source,
        "target": target,
        "ts": now_ms(),
        "schemaVersion": schema_version,
        "payload": payload,
    }
    if correlation_id:
        message["correlationId"] = correlation_id
    return message


def make_presence_envelope(
    *,
    client_id: str,
    service_name: str | None,
    version: str,
    provides: list[str],
    consumes: list[str],
    tags: list[str],
) -> dict[str, Any]:
    source: dict[str, Any] = {"clientId": client_id}
    if service_name:
        source["serviceName"] = service_name

    return make_envelope(
        msg_type="presence",
        name="presence",
        source=source,
        target={"serviceName": "hub"},
        schema_version=1,
        payload={
            "clientId": client_id,
            "serviceName": service_name,
            "version": version,
            "provides": provides,
            "consumes": consumes,
            "tags": tags,
        },
    )


async def send_json(ws: Any, message: dict[str, Any]) -> None:
    await ws.send(json.dumps(message))


def decode_json(raw: str) -> dict[str, Any]:
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("Expected object JSON message")
    return parsed
