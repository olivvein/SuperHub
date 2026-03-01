from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

import websockets

from .protocol import (
    decode_json,
    default_http_url,
    default_ws_url,
    encode_json,
    make_envelope,
    make_presence_envelope,
    new_id,
    ws_url_with_token,
    tls_context_for_url,
)

EventHandler = Callable[[dict[str, Any]], Awaitable[None] | None]
StateWatchHandler = Callable[[str, Any, dict[str, Any]], Awaitable[None] | None]
RpcRequestHandler = Callable[[Any, dict[str, Any]], Awaitable[Any] | Any]


class HubRpcError(RuntimeError):
    def __init__(self, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


class SuperHubClient:
    def __init__(
        self,
        *,
        http_url: str | None = None,
        ws_url: str | None = None,
        token: str | None = None,
        client_id: str | None = None,
        service_name: str | None = None,
        version: str = "0.1.0",
        provides: list[str] | None = None,
        consumes: list[str] | None = None,
        tags: list[str] | None = None,
        ping_interval: int = 20,
        ping_timeout: int = 20,
        max_size: int = 1024 * 1024,
    ) -> None:
        self.http_url = (http_url or default_http_url()).rstrip("/")
        self.ws_url = ws_url
        self.token = token
        self.client_id = client_id or f"py-{new_id()}"
        self.service_name = service_name
        self.version = version
        self.provides = provides or []
        self.consumes = consumes or []
        self.tags = tags or []
        self.ping_interval = ping_interval
        self.ping_timeout = ping_timeout
        self.max_size = max_size

        self._ws: Any = None
        self._reader_task: asyncio.Task[None] | None = None
        self._closing = False

        self._pending_rpcs: dict[str, asyncio.Future[Any]] = {}
        self._subscriptions: dict[str, tuple[dict[str, Any], EventHandler]] = {}
        self._state_watches: dict[str, tuple[str, StateWatchHandler]] = {}
        self._rpc_handlers: dict[str, RpcRequestHandler] = {}

        self._on_open: list[Callable[[], Awaitable[None] | None]] = []
        self._on_close: list[Callable[[], Awaitable[None] | None]] = []
        self._on_error: list[Callable[[Any], Awaitable[None] | None]] = []

    def add_open_listener(self, callback: Callable[[], Awaitable[None] | None]) -> None:
        self._on_open.append(callback)

    def add_close_listener(self, callback: Callable[[], Awaitable[None] | None]) -> None:
        self._on_close.append(callback)

    def add_error_listener(self, callback: Callable[[Any], Awaitable[None] | None]) -> None:
        self._on_error.append(callback)

    def on_rpc(self, method_name: str, handler: RpcRequestHandler) -> None:
        self._rpc_handlers[method_name] = handler

    async def connect(self) -> None:
        self._closing = False
        ws_url = self.ws_url or default_ws_url(self.http_url)
        ws_url = ws_url_with_token(ws_url, self.token)

        self._ws = await websockets.connect(
            ws_url,
            ping_interval=self.ping_interval,
            ping_timeout=self.ping_timeout,
            max_size=self.max_size,
            ssl=tls_context_for_url(ws_url),
        )

        await self._send_presence()
        await self._replay_subscriptions()
        await self._replay_state_watches()

        self._reader_task = asyncio.create_task(self._reader_loop())
        await self._emit_open()

    async def close(self) -> None:
        self._closing = True

        if self._reader_task:
            self._reader_task.cancel()
            self._reader_task = None

        for fut in self._pending_rpcs.values():
            if not fut.done():
                fut.set_exception(RuntimeError("Client closed"))
        self._pending_rpcs.clear()

        if self._ws is not None:
            await self._ws.close()
            self._ws = None

        await self._emit_close()

    async def publish(
        self,
        name: str,
        payload: Any,
        target: dict[str, str] | str = "*",
        schema_version: int = 1,
    ) -> None:
        await self._send(
            msg_type="event",
            name=name,
            target=target,
            payload=payload,
            schema_version=schema_version,
        )

    async def subscribe(
        self,
        *,
        names: list[str] | None = None,
        name_prefix: str | None = None,
        handler: EventHandler,
    ) -> Callable[[], Awaitable[None]]:
        subscription_id = new_id()
        filter_payload: dict[str, Any] = {}
        if names:
            filter_payload["names"] = names
        if name_prefix:
            filter_payload["namePrefix"] = name_prefix

        if not filter_payload:
            raise ValueError("subscribe requires names or name_prefix")

        self._subscriptions[subscription_id] = (filter_payload, handler)
        await self._send(
            msg_type="cmd",
            name="subscribe",
            target={"serviceName": "hub"},
            payload={
                "subscriptionId": subscription_id,
                **filter_payload,
            },
            schema_version=1,
        )

        async def unsubscribe() -> None:
            self._subscriptions.pop(subscription_id, None)
            await self._send(
                msg_type="cmd",
                name="unsubscribe",
                target={"serviceName": "hub"},
                payload={"subscriptionId": subscription_id},
                schema_version=1,
            )

        return unsubscribe

    async def watch_state(self, prefix: str, handler: StateWatchHandler) -> Callable[[], Awaitable[None]]:
        watch_id = new_id()
        self._state_watches[watch_id] = (prefix, handler)
        await self._send(
            msg_type="cmd",
            name="state_watch",
            target={"serviceName": "hub"},
            payload={"watchId": watch_id, "prefix": prefix},
            schema_version=1,
        )

        async def unwatch() -> None:
            self._state_watches.pop(watch_id, None)
            await self._send(
                msg_type="cmd",
                name="state_unwatch",
                target={"serviceName": "hub"},
                payload={"watchId": watch_id},
                schema_version=1,
            )

        return unwatch

    async def set_state(self, path: str, value: Any) -> None:
        await self._send(
            msg_type="cmd",
            name="state_set",
            target={"serviceName": "hub"},
            payload={"path": path, "value": value},
            schema_version=1,
        )

    async def patch_state(self, path: str, patch: list[dict[str, Any]]) -> None:
        await self._send(
            msg_type="cmd",
            name="state_patch",
            target={"serviceName": "hub"},
            payload={"path": path, "patch": patch},
            schema_version=1,
        )

    async def rpc(
        self,
        service_name: str,
        method_name: str,
        args: Any,
        timeout_ms: int = 15000,
    ) -> Any:
        correlation_id = new_id()
        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()
        self._pending_rpcs[correlation_id] = future

        await self._send(
            msg_type="rpc_req",
            name=method_name,
            target={"serviceName": service_name},
            correlation_id=correlation_id,
            payload={
                "method": method_name,
                "args": args,
                "timeoutMs": timeout_ms,
            },
            schema_version=1,
        )

        try:
            return await asyncio.wait_for(future, timeout_ms / 1000)
        except asyncio.TimeoutError as exc:
            self._pending_rpcs.pop(correlation_id, None)
            raise TimeoutError(f"RPC timeout after {timeout_ms}ms for {service_name}.{method_name}") from exc

    async def get_state(self, path: str) -> Any:
        return await self.rpc("hub", "state_get", {"path": path})

    async def _send_presence(self) -> None:
        await self._send_raw(
            make_presence_envelope(
                client_id=self.client_id,
                service_name=self.service_name,
                version=self.version,
                provides=self.provides,
                consumes=self.consumes,
                tags=self.tags,
            )
        )

    async def _send(
        self,
        *,
        msg_type: str,
        name: str,
        target: dict[str, str] | str,
        payload: Any,
        schema_version: int = 1,
        correlation_id: str | None = None,
    ) -> None:
        source: dict[str, Any] = {"clientId": self.client_id}
        if self.service_name:
            source["serviceName"] = self.service_name

        envelope = make_envelope(
            msg_type=msg_type,
            name=name,
            source=source,
            target=target,
            payload=payload,
            schema_version=schema_version,
            correlation_id=correlation_id,
        )
        await self._send_raw(envelope)

    async def _send_raw(self, envelope: dict[str, Any]) -> None:
        if self._ws is None:
            raise RuntimeError("Client is not connected")
        await self._ws.send(encode_json(envelope))

    async def _reader_loop(self) -> None:
        if self._ws is None:
            return

        try:
            async for raw in self._ws:
                message = decode_json(raw)
                await self._handle_message(message)
        except asyncio.CancelledError:
            return
        except Exception as error:
            await self._emit_error(error)
        finally:
            if not self._closing:
                await self._emit_close()

    async def _handle_message(self, message: dict[str, Any]) -> None:
        msg_type = message.get("type")

        if msg_type == "rpc_res":
            correlation_id = message.get("correlationId")
            if isinstance(correlation_id, str):
                pending = self._pending_rpcs.pop(correlation_id, None)
                if pending is not None and not pending.done():
                    payload = message.get("payload")
                    if isinstance(payload, dict) and payload.get("ok") is True:
                        pending.set_result(payload.get("result"))
                    else:
                        error = payload.get("error") if isinstance(payload, dict) else {}
                        if not isinstance(error, dict):
                            error = {}
                        pending.set_exception(
                            HubRpcError(
                                str(error.get("code") or "INTERNAL_ERROR"),
                                str(error.get("message") or "Unknown RPC error"),
                                error.get("details"),
                            )
                        )
            return

        if msg_type == "rpc_req":
            await self._handle_rpc_request(message)
            return

        if msg_type == "state_patch":
            payload = message.get("payload")
            if isinstance(payload, dict):
                path = payload.get("path")
                value = payload.get("value")
                if isinstance(path, str):
                    for prefix, handler in self._state_watches.values():
                        if path.startswith(prefix):
                            await _maybe_await(handler(path, value, message.get("source") or {}))
            return

        if msg_type in {"event", "cmd"}:
            for filt, handler in self._subscriptions.values():
                if _matches_filter(message, filt):
                    await _maybe_await(handler(message))
            return

        if msg_type == "error":
            await self._emit_error(message.get("payload"))

    async def _handle_rpc_request(self, message: dict[str, Any]) -> None:
        correlation_id = message.get("correlationId")
        if not isinstance(correlation_id, str):
            return

        payload = message.get("payload")
        if not isinstance(payload, dict):
            payload = {}
        method = payload.get("method")
        if not isinstance(method, str):
            method = str(message.get("name") or "")
        args = payload.get("args")

        handler = self._rpc_handlers.get(method)
        if handler is None:
            await self._send(
                msg_type="rpc_res",
                name=str(message.get("name") or method),
                target={"serviceName": "hub"},
                correlation_id=correlation_id,
                payload={
                    "ok": False,
                    "error": {
                        "code": "METHOD_NOT_FOUND",
                        "message": f"No handler registered for {method}",
                    },
                },
                schema_version=1,
            )
            return

        try:
            result = await _maybe_await(
                handler(
                    args,
                    {
                        "correlationId": correlation_id,
                        "method": method,
                        "source": message.get("source") or {},
                        "envelope": message,
                    },
                )
            )
            await self._send(
                msg_type="rpc_res",
                name=str(message.get("name") or method),
                target={"serviceName": "hub"},
                correlation_id=correlation_id,
                payload={"ok": True, "result": result},
                schema_version=1,
            )
        except Exception as error:
            await self._send(
                msg_type="rpc_res",
                name=str(message.get("name") or method),
                target={"serviceName": "hub"},
                correlation_id=correlation_id,
                payload={
                    "ok": False,
                    "error": {
                        "code": "INTERNAL_ERROR",
                        "message": str(error),
                    },
                },
                schema_version=1,
            )

    async def _replay_subscriptions(self) -> None:
        for subscription_id, (filt, _handler) in self._subscriptions.items():
            await self._send(
                msg_type="cmd",
                name="subscribe",
                target={"serviceName": "hub"},
                payload={"subscriptionId": subscription_id, **filt},
                schema_version=1,
            )

    async def _replay_state_watches(self) -> None:
        for watch_id, (prefix, _handler) in self._state_watches.items():
            await self._send(
                msg_type="cmd",
                name="state_watch",
                target={"serviceName": "hub"},
                payload={"watchId": watch_id, "prefix": prefix},
                schema_version=1,
            )

    async def _emit_open(self) -> None:
        for callback in self._on_open:
            await _maybe_await(callback())

    async def _emit_close(self) -> None:
        for callback in self._on_close:
            await _maybe_await(callback())

    async def _emit_error(self, error: Any) -> None:
        if not self._on_error:
            return
        for callback in self._on_error:
            await _maybe_await(callback(error))


def _matches_filter(message: dict[str, Any], filter_payload: dict[str, Any]) -> bool:
    name = message.get("name")
    if not isinstance(name, str):
        return False

    names = filter_payload.get("names")
    if isinstance(names, list) and names:
        return name in names

    name_prefix = filter_payload.get("namePrefix")
    if isinstance(name_prefix, str) and name_prefix:
        return name.startswith(name_prefix)

    return False


async def _maybe_await(value: Awaitable[Any] | Any) -> Any:
    if asyncio.iscoroutine(value) or isinstance(value, asyncio.Future):
        return await value
    return value
