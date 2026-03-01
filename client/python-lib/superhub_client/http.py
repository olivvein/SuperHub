from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .protocol import default_http_url, now_ms, tls_context_for_url


class HubHttpClient:
    def __init__(self, base_url: str | None = None, token: str | None = None, timeout_s: float = 10.0) -> None:
        self.base_url = (base_url or default_http_url()).rstrip("/")
        self.token = token
        self.timeout_s = timeout_s

    def request_json(
        self,
        *,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        token: str | None = None,
    ) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        payload = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")

        request = urllib.request.Request(url=url, method=method.upper(), data=payload)
        request.add_header("Accept", "application/json")
        if body is not None:
            request.add_header("Content-Type", "application/json")

        effective_token = token if token is not None else self.token
        if effective_token:
            request.add_header("X-Hub-Token", effective_token)

        try:
            with urllib.request.urlopen(
                request,
                timeout=self.timeout_s,
                context=tls_context_for_url(self.base_url),
            ) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw)
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {error.code} {path}: {raw}") from error

    def health(self) -> dict[str, Any]:
        return self.request_json(method="GET", path="/api/health")

    def services(self) -> dict[str, Any]:
        return self.request_json(method="GET", path="/api/services")

    def clients(self) -> dict[str, Any]:
        return self.request_json(method="GET", path="/api/clients")

    def state(self, path: str) -> dict[str, Any]:
        quoted = urllib.parse.quote(path, safe="")
        return self.request_json(method="GET", path=f"/api/state?path={quoted}")

    def publish(
        self,
        *,
        name: str,
        payload: Any,
        target: dict[str, str] | str = "*",
        schema_version: int = 1,
        msg_type: str = "event",
    ) -> dict[str, Any]:
        return self.request_json(
            method="POST",
            path="/api/publish",
            body={
                "name": name,
                "type": msg_type,
                "target": target,
                "schemaVersion": schema_version,
                "payload": payload,
            },
        )

    def rpc(self, *, service_name: str, method: str, args: Any, timeout_ms: int = 15000) -> dict[str, Any]:
        return self.request_json(
            method="POST",
            path="/api/rpc",
            body={
                "serviceName": service_name,
                "method": method,
                "args": args,
                "timeoutMs": timeout_ms,
            },
        )

    def ping_event(self, name: str = "demo.ping") -> dict[str, Any]:
        return self.publish(name=name, payload={"at": now_ms()})
