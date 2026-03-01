import WebSocket from "isomorphic-ws";
import {
  HUB_PROTOCOL_VERSION,
  HubEnvelope,
  HubMessageType,
  HubTarget,
  RpcErrorShape,
  RpcResponsePayload,
  SubscribePayload,
  normalizeRpcError
} from "@superhub/contracts";

export interface HubClientOptions {
  httpUrl: string;
  wsUrl?: string;
  token?: string;
  clientId: string;
  serviceName?: string;
  version?: string;
  provides?: string[];
  consumes?: string[];
  tags?: string[];
  reconnect?: {
    enabled?: boolean;
    minDelayMs?: number;
    maxDelayMs?: number;
    factor?: number;
    jitterRatio?: number;
  };
  defaultRpcTimeoutMs?: number;
  debug?: boolean;
}

export type EnvelopeHandler = (message: HubEnvelope) => void;
export type StateWatchHandler = (path: string, value: unknown, source: HubEnvelope["source"]) => void;

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface InternalSubscription {
  filter: SubscribePayload;
  handler: EnvelopeHandler;
}

const DEFAULT_RECONNECT = {
  enabled: true,
  minDelayMs: 500,
  maxDelayMs: 10000,
  factor: 1.8,
  jitterRatio: 0.2
};

export class HubClient {
  private readonly options: Required<Pick<HubClientOptions, "clientId">> & HubClientOptions;
  private socket: WebSocket | null = null;
  private closedExplicitly = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRpcs = new Map<string, PendingRpc>();
  private subscriptions = new Map<string, InternalSubscription>();
  private stateWatches = new Map<string, StateWatchHandler>();
  private openListeners = new Set<() => void>();
  private closeListeners = new Set<() => void>();
  private errorListeners = new Set<(error: unknown) => void>();

  constructor(options: HubClientOptions) {
    this.options = {
      ...options,
      reconnect: {
        ...DEFAULT_RECONNECT,
        ...(options.reconnect ?? {})
      },
      defaultRpcTimeoutMs: options.defaultRpcTimeoutMs ?? 15000
    };
  }

  async connect(): Promise<void> {
    this.closedExplicitly = false;
    await this.openSocket();
  }

  disconnect(): void {
    this.closedExplicitly = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.rejectAllPending(new Error("Client disconnected"));
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: (error: unknown) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  publish(name: string, payload: unknown, target: HubTarget = "*", schemaVersion = 1): void {
    this.sendEnvelope({
      type: "event",
      name,
      target,
      payload,
      schemaVersion
    });
  }

  subscribe(filter: SubscribePayload, handler: EnvelopeHandler): () => void {
    const id = randomId();
    this.subscriptions.set(id, { filter, handler });
    this.sendEnvelope({
      type: "cmd",
      name: "subscribe",
      target: { serviceName: "hub" },
      payload: {
        subscriptionId: id,
        ...filter
      },
      schemaVersion: 1
    });

    return () => {
      this.subscriptions.delete(id);
      this.sendEnvelope({
        type: "cmd",
        name: "unsubscribe",
        target: { serviceName: "hub" },
        payload: { subscriptionId: id },
        schemaVersion: 1
      });
    };
  }

  async rpc<TResponse = unknown>(
    serviceName: string,
    methodName: string,
    args: unknown,
    timeoutMs?: number
  ): Promise<TResponse> {
    const correlationId = randomId();
    const effectiveTimeout = timeoutMs ?? this.options.defaultRpcTimeoutMs ?? 15000;

    const result = new Promise<TResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRpcs.delete(correlationId);
        reject(new Error(`RPC timeout after ${effectiveTimeout}ms for ${serviceName}.${methodName}`));
      }, effectiveTimeout);

      this.pendingRpcs.set(correlationId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout
      });
    });

    this.sendEnvelope({
      type: "rpc_req",
      name: methodName,
      target: { serviceName },
      correlationId,
      payload: {
        method: methodName,
        args,
        timeoutMs: effectiveTimeout
      },
      schemaVersion: 1
    });

    return result;
  }

  async getState<TValue = unknown>(path: string): Promise<TValue | null> {
    return this.rpc<TValue | null>("hub", "state_get", { path });
  }

  setState(path: string, value: unknown): void {
    this.sendEnvelope({
      type: "cmd",
      name: "state_set",
      target: { serviceName: "hub" },
      payload: { path, value },
      schemaVersion: 1
    });
  }

  patchState(path: string, patch: Array<{ op: string; path: string; value?: unknown; from?: string }>): void {
    this.sendEnvelope({
      type: "cmd",
      name: "state_patch",
      target: { serviceName: "hub" },
      payload: { path, patch },
      schemaVersion: 1
    });
  }

  watchState(prefix: string, handler: StateWatchHandler): () => void {
    const watchId = randomId();
    this.stateWatches.set(watchId, handler);

    this.sendEnvelope({
      type: "cmd",
      name: "state_watch",
      target: { serviceName: "hub" },
      payload: { watchId, prefix },
      schemaVersion: 1
    });

    return () => {
      this.stateWatches.delete(watchId);
      this.sendEnvelope({
        type: "cmd",
        name: "state_unwatch",
        target: { serviceName: "hub" },
        payload: { watchId },
        schemaVersion: 1
      });
    };
  }

  private async openSocket(): Promise<void> {
    const wsUrl = this.options.wsUrl ?? this.options.httpUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
    const url = new URL(wsUrl);
    if (this.options.token) {
      url.searchParams.set("token", this.options.token);
    }

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url.toString());
      this.socket = socket;
      const connectTimeout = setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          socket.close();
          reject(new Error("Unable to connect to hub"));
        }
      }, 5000);

      socket.onopen = () => {
        clearTimeout(connectTimeout);
        this.reconnectAttempt = 0;
        this.sendPresence();
        for (const listener of this.openListeners) {
          listener();
        }
        resolve();
      };

      socket.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      socket.onerror = (event) => {
        const error = (event as unknown as { error?: unknown }).error ?? new Error("WebSocket error");
        for (const listener of this.errorListeners) {
          listener(error);
        }
      };

      socket.onclose = () => {
        clearTimeout(connectTimeout);
        this.socket = null;
        for (const listener of this.closeListeners) {
          listener();
        }
        if (!this.closedExplicitly && this.options.reconnect?.enabled) {
          this.scheduleReconnect();
        }
      };
    });
  }

  private scheduleReconnect(): void {
    const reconnect = this.options.reconnect ?? DEFAULT_RECONNECT;
    const base = Math.min(
      reconnect.maxDelayMs ?? DEFAULT_RECONNECT.maxDelayMs,
      (reconnect.minDelayMs ?? DEFAULT_RECONNECT.minDelayMs) *
        Math.pow(reconnect.factor ?? DEFAULT_RECONNECT.factor, this.reconnectAttempt)
    );
    const jitter = base * (reconnect.jitterRatio ?? DEFAULT_RECONNECT.jitterRatio) * Math.random();
    const delay = Math.round(base + jitter);

    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      void this.openSocket().catch((error) => {
        if (this.options.debug) {
          console.error("[hub-sdk] reconnect failed", error);
        }
      });
    }, delay);
  }

  private sendPresence(): void {
    this.sendEnvelope({
      type: "presence",
      name: "presence",
      target: { serviceName: "hub" },
      payload: {
        clientId: this.options.clientId,
        serviceName: this.options.serviceName,
        version: this.options.version ?? "0.1.0",
        provides: this.options.provides ?? [],
        consumes: this.options.consumes ?? [],
        tags: this.options.tags ?? []
      },
      schemaVersion: 1
    });
  }

  private sendEnvelope(
    input: Omit<HubEnvelope, "id" | "v" | "source" | "ts"> & {
      source?: HubEnvelope["source"];
    }
  ): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Socket is not connected");
    }

    const envelope: HubEnvelope = {
      v: HUB_PROTOCOL_VERSION,
      id: randomId(),
      type: input.type,
      name: input.name,
      source: input.source ?? {
        clientId: this.options.clientId,
        serviceName: this.options.serviceName
      },
      target: input.target,
      ts: Date.now(),
      correlationId: input.correlationId,
      schemaVersion: input.schemaVersion,
      payload: input.payload,
      meta: input.meta
    };

    this.socket.send(JSON.stringify(envelope));
  }

  private handleMessage(raw: WebSocket.Data): void {
    let parsed: HubEnvelope;

    try {
      const text = decodeWsData(raw);
      if (text == null) {
        return;
      }
      parsed = JSON.parse(text) as HubEnvelope;
    } catch (error) {
      if (this.options.debug) {
        console.error("[hub-sdk] failed to parse inbound message", error);
      }
      return;
    }

    if (parsed.type === "rpc_res" && parsed.correlationId) {
      const pending = this.pendingRpcs.get(parsed.correlationId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pendingRpcs.delete(parsed.correlationId);

      const response = parsed.payload as RpcResponsePayload;
      if (response.ok) {
        pending.resolve(response.result);
      } else {
        const normalized = normalizeRpcError(response.error);
        pending.reject(Object.assign(new Error(normalized.message), { code: normalized.code, details: normalized.details }));
      }
      return;
    }

    if (parsed.type === "state_patch") {
      const payload = parsed.payload as { path?: string; value?: unknown };
      if (typeof payload.path === "string") {
        for (const handler of this.stateWatches.values()) {
          handler(payload.path, payload.value, parsed.source);
        }
      }
      return;
    }

    if (parsed.type === "event" || parsed.type === "cmd") {
      for (const subscription of this.subscriptions.values()) {
        if (matchesFilter(parsed, subscription.filter)) {
          subscription.handler(parsed);
        }
      }
      return;
    }

    if (parsed.type === "error") {
      const payload = parsed.payload as RpcErrorShape;
      for (const listener of this.errorListeners) {
        listener(payload);
      }
    }
  }

  private rejectAllPending(error: unknown): void {
    for (const [id, pending] of this.pendingRpcs.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRpcs.delete(id);
    }
  }
}

function matchesFilter(message: HubEnvelope, filter: SubscribePayload): boolean {
  if (filter.names?.length) {
    return filter.names.includes(message.name);
  }

  if (filter.namePrefix) {
    return message.name.startsWith(filter.namePrefix);
  }

  return false;
}

function randomId(): string {
  const maybeRandomUuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (maybeRandomUuid) {
    return maybeRandomUuid();
  }

  return `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function decodeWsData(raw: WebSocket.Data): string | null {
  if (typeof raw === "string") {
    return raw;
  }

  if (raw instanceof ArrayBuffer) {
    return new TextDecoder().decode(raw);
  }

  if (ArrayBuffer.isView(raw)) {
    return new TextDecoder().decode(raw);
  }

  if (Array.isArray(raw)) {
    const chunks = raw.map((chunk) => decodeWsData(chunk)).filter((chunk): chunk is string => chunk != null);
    return chunks.join("");
  }

  return null;
}
