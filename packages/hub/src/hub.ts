import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import websocketPlugin from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { WebSocket, type RawData } from "ws";
import {
  createDefaultContractRegistry,
  HubEnvelope,
  HubEnvelopeSchema,
  HubMessageType,
  HubTarget,
  PresencePayloadSchema,
  RpcRequestPayload,
  RpcRequestPayloadSchema,
  RpcResponsePayload,
  RpcResponsePayloadSchema,
  StatePatchPayloadSchema,
  StateSetPayloadSchema,
  SubscribePayload,
  SubscribePayloadSchema,
  hubError,
  nowEpochMs
} from "@superhub/contracts";
import { HubConfig } from "./config.js";
import { HubLogger } from "./logger.js";
import { HubPersistence } from "./persistence.js";
import { StateStore } from "./state-store.js";
import ipaddr from "ipaddr.js";

type Direction = "in" | "out" | "drop";

interface SessionQueueItem {
  raw: string;
  envelope: HubEnvelope;
  bytes: number;
  critical: boolean;
}

interface SessionState {
  sessionId: string;
  socket: WebSocket;
  connectedAt: number;
  lastSeen: number;
  instanceId: string;
  clientId: string;
  serviceName?: string;
  version: string;
  provides: string[];
  consumes: string[];
  tags: string[];
  subscriptions: Map<string, SubscribePayload>;
  stateWatches: Map<string, string>;
  recentIds: Map<string, number>;
  queue: SessionQueueItem[];
  queueBytes: number;
  ip: string;
  rateWindowMinute: number;
  rateWindowCount: number;
}

interface PendingRpc {
  fromSessionId: string;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingHttpRpc {
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (payload: RpcResponsePayload) => void;
  reject: (error: Error) => void;
}

interface PresenceRecord {
  serviceName: string;
  clientId: string;
  instanceId: string;
  sessionId: string;
  provides: string[];
  consumes: string[];
  tags: string[];
  version: string;
  lastSeenTs: number;
  online: boolean;
}

interface InspectorRecord {
  ts: number;
  direction: Direction;
  sessionId: string;
  envelope: HubEnvelope;
  reason?: string;
}

interface Metrics {
  messagesIn: Record<HubMessageType, number>;
  messagesOut: Record<HubMessageType, number>;
  droppedMessages: number;
  reconnectCount: number;
  rpcLatenciesMs: number[];
}

interface HttpPublishBody {
  name: string;
  payload: unknown;
  target?: HubTarget;
  schemaVersion?: number;
  type?: Extract<HubMessageType, "event" | "cmd">;
}

interface HttpRpcBody {
  serviceName: string;
  method: string;
  args: unknown;
  timeoutMs?: number;
}

interface PairPayload {
  url: string;
  token?: string;
}

export interface HubRuntime {
  app: FastifyInstance;
  close: () => Promise<void>;
}

export async function createHubRuntime(config: HubConfig): Promise<HubRuntime> {
  const logger = new HubLogger(config.logging.level);
  const persistence = new HubPersistence(config.persistence);
  const stateStore = new StateStore();
  const contractRegistry = createDefaultContractRegistry();

  stateStore.loadSnapshots(persistence.loadSnapshots());

  const app = Fastify({
    logger: false,
    bodyLimit: config.limits.maxMessageSizeBytes
  });

  const sessions = new Map<string, SessionState>();
  const sessionIdsByClient = new Map<string, Set<string>>();
  const providerSessionIds = new Map<string, Set<string>>();
  const roundRobinCursor = new Map<string, number>();
  const pendingRpc = new Map<string, PendingRpc>();
  const pendingHttpRpc = new Map<string, PendingHttpRpc>();
  const presenceByServiceInstance = new Map<string, PresenceRecord>();
  const inspector: InspectorRecord[] = [];
  const messageNameCounter = new Map<string, number>();
  const clientSessionHistory = new Map<string, string>();

  const metrics: Metrics = {
    messagesIn: {
      event: 0,
      cmd: 0,
      rpc_req: 0,
      rpc_res: 0,
      state_patch: 0,
      presence: 0,
      error: 0
    },
    messagesOut: {
      event: 0,
      cmd: 0,
      rpc_req: 0,
      rpc_res: 0,
      state_patch: 0,
      presence: 0,
      error: 0
    },
    droppedMessages: 0,
    reconnectCount: 0,
    rpcLatenciesMs: []
  };

  await app.register(cors, {
    origin: (origin: string | undefined, callback: (error: Error | null, allow: boolean) => void) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (config.cors.origins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("origin not allowed"), false);
    },
    allowedHeaders: config.cors.allowHeaders,
    credentials: false
  });

  await app.register(websocketPlugin, {
    options: {
      maxPayload: config.limits.maxMessageSizeBytes
    }
  });

  const hasConsoleAssets = pathExists(config.staticHosting.consoleDir);

  if (config.staticHosting.appsDir && pathExists(config.staticHosting.appsDir)) {
    await app.register(fastifyStatic, {
      root: config.staticHosting.appsDir,
      prefix: "/apps/",
      decorateReply: false
    });
  }

  app.get("/", async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.redirect("/console/");
  });

  if (hasConsoleAssets) {
    app.get("/console", async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.redirect("/console/");
    });

    app.get("/console/", async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const served = serveStaticFromDir(reply, config.staticHosting.consoleDir, "", "index.html");
        if (!served) {
          return reply.code(404).send({ error: hubError("NOT_FOUND", "Console asset not found") });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isMalformedPath = message.includes("URI malformed");
        logger.error("console.asset.error", {
          wildcard: "",
          consoleDir: config.staticHosting.consoleDir,
          error: message
        });
        return reply
          .code(isMalformedPath ? 400 : 500)
          .send({ error: hubError(isMalformedPath ? "BAD_REQUEST" : "CONSOLE_ASSET_ERROR", "Failed to serve console asset") });
      }
    });

    app.get("/console/*", async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as Record<string, unknown> | undefined;
      const wildcard = typeof params?.["*"] === "string" ? params["*"] : "";

      try {
        const served = serveStaticFromDir(reply, config.staticHosting.consoleDir, wildcard, "index.html");
        if (!served) {
          return reply.code(404).send({ error: hubError("NOT_FOUND", "Console asset not found") });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isMalformedPath = message.includes("URI malformed");
        logger.error("console.asset.error", {
          wildcard,
          consoleDir: config.staticHosting.consoleDir,
          error: message
        });
        return reply
          .code(isMalformedPath ? 400 : 500)
          .send({ error: hubError(isMalformedPath ? "BAD_REQUEST" : "CONSOLE_ASSET_ERROR", "Failed to serve console asset") });
      }
    });
  }

  app.get("/api/health", async () => {
    return {
      ok: true,
      ts: nowEpochMs(),
      uptimeSec: Math.round(process.uptime()),
      sessions: sessions.size,
      services: providerSessionIds.size
    };
  });

  app.get(
    "/api/services",
    {
      preHandler: [authorizeHttp]
    },
    async () => {
      const records = Array.from(presenceByServiceInstance.values())
        .sort((a, b) => a.serviceName.localeCompare(b.serviceName) || a.instanceId.localeCompare(b.instanceId))
        .map((record) => ({
          ...record,
          health: record.online ? "online" : "offline"
        }));
      return {
        services: records
      };
    }
  );

  app.get(
    "/api/clients",
    {
      preHandler: [authorizeHttp]
    },
    async () => {
      return {
        clients: Array.from(sessions.values()).map((session) => ({
          sessionId: session.sessionId,
          clientId: session.clientId,
          serviceName: session.serviceName,
          instanceId: session.instanceId,
          ip: session.ip,
          connectedAt: session.connectedAt,
          lastSeen: session.lastSeen,
          provides: session.provides,
          consumes: session.consumes,
          tags: session.tags
        }))
      };
    }
  );

  app.get(
    "/api/topics",
    {
      preHandler: [authorizeHttp]
    },
    async () => {
      return {
        topics: Array.from(messageNameCounter.entries())
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count)
      };
    }
  );

  app.get(
    "/api/messages",
    {
      preHandler: [authorizeHttp]
    },
    async () => {
      return {
        messages: inspector
      };
    }
  );

  app.get(
    "/api/config",
    {
      preHandler: [authorizeHttp]
    },
    async () => {
      return {
        domain: config.domain,
        listen: config.listen,
        cors: config.cors,
        limits: config.limits,
        validation: config.validation,
        persistence: {
          enabled: config.persistence.enabled,
          auditEnabled: config.persistence.auditEnabled,
          sqlitePath: config.persistence.sqlitePath
        },
        security: {
          tokenConfigured: Boolean(config.security.token),
          pairingEnabled: config.security.pairingEnabled,
          allowlistSubnets: config.security.allowlistSubnets
        }
      };
    }
  );

  app.get(
    "/api/metrics",
    {
      preHandler: [authorizeHttp]
    },
    async () => {
      const latencies = [...metrics.rpcLatenciesMs].sort((a, b) => a - b);
      const mean = latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : 0;
      const p95 = percentile(latencies, 95);

      return {
        messagesIn: metrics.messagesIn,
        messagesOut: metrics.messagesOut,
        droppedMessages: metrics.droppedMessages,
        reconnectCount: metrics.reconnectCount,
        rpcLatencyAvgMs: Number(mean.toFixed(2)),
        rpcLatencyP95Ms: Number(p95.toFixed(2))
      };
    }
  );

  app.get(
    "/api/state",
    {
      preHandler: [authorizeHttp]
    },
    async (request: FastifyRequest) => {
      const query = request.query as { path?: string; prefix?: string };
      if (query.path) {
        return { path: query.path, value: stateStore.get(query.path) };
      }

      return {
        entries: stateStore.list(query.prefix)
      };
    }
  );

  app.post(
    "/api/publish",
    {
      preHandler: [authorizeHttp]
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as HttpPublishBody;

      if (!body?.name) {
        return reply.code(400).send({ error: hubError("INVALID_REQUEST", "name is required") });
      }

      const envelope = createEnvelope({
        type: body.type ?? "event",
        name: body.name,
        source: {
          clientId: "http-api",
          serviceName: "hub"
        },
        target: body.target ?? "*",
        payload: body.payload,
        schemaVersion: body.schemaVersion ?? 1
      });

      routeMessage(null, envelope);

      return { ok: true, id: envelope.id };
    }
  );

  app.post(
    "/api/rpc",
    {
      preHandler: [authorizeHttp]
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as HttpRpcBody;
      if (!body?.serviceName || !body?.method) {
        return reply.code(400).send({ error: hubError("INVALID_REQUEST", "serviceName and method are required") });
      }

      const correlationId = randomUUID();
      const timeoutMs = Math.min(Math.max(body.timeoutMs ?? 15000, 100), 120000);

      const envelope = createEnvelope({
        type: "rpc_req",
        name: body.method,
        source: {
          clientId: "http-api",
          serviceName: "hub"
        },
        target: { serviceName: body.serviceName },
        correlationId,
        schemaVersion: 1,
        payload: {
          method: body.method,
          args: body.args,
          timeoutMs
        } satisfies RpcRequestPayload
      });

      const response = await new Promise<RpcResponsePayload>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingHttpRpc.delete(correlationId);
          reject(new Error(`RPC timeout for ${body.serviceName}.${body.method}`));
        }, timeoutMs);

        pendingHttpRpc.set(correlationId, {
          startedAt: nowEpochMs(),
          timeout,
          resolve,
          reject
        });

        routeRpcRequest(null, envelope);
      }).catch((error) => {
        return {
          ok: false,
          error: hubError("RPC_TIMEOUT", error instanceof Error ? error.message : "RPC timeout")
        } satisfies RpcResponsePayload;
      });

      return { correlationId, response };
    }
  );

  app.get("/console/pair", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.security.pairingEnabled) {
      return reply.code(404).send("Pairing is disabled");
    }

    const remoteIp = request.ip;
    if (!isIpAllowlisted(remoteIp, config.security.allowlistSubnets)) {
      return reply.code(403).send("Forbidden");
    }

    const payload: PairPayload = {
      url: `https://${config.domain}`,
      token: config.security.token
    };

    const serialized = JSON.stringify(payload);

    return reply
      .type("text/html; charset=utf-8")
      .send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>SuperHub Pairing</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 760px; margin: 40px auto; padding: 0 16px; }
      code, pre { background: #f3f3f3; padding: 4px 6px; border-radius: 6px; }
      pre { white-space: pre-wrap; }
      .pill { display: inline-block; padding: 4px 8px; border-radius: 999px; background: #111; color: #fff; }
    </style>
  </head>
  <body>
    <h1>Pairing SuperHub</h1>
    <p class="pill">${escapeHtml(config.domain)}</p>
    <p>Copiez ce JSON dans votre app cliente (ou scannez avec un utilitaire QR externe).</p>
    <pre id="payload">${escapeHtml(serialized)}</pre>
  </body>
</html>`);
  });

  app.get(
    "/ws",
    {
      websocket: true
    },
    (socket: WebSocket, request: FastifyRequest) => {
      const tokenResult = authorizeTokenForRequest(request);
      if (!tokenResult.ok) {
        socket.send(JSON.stringify(errorEnvelope("AUTH_REQUIRED", tokenResult.reason, null, "*")));
        socket.close(1008, tokenResult.reason);
        return;
      }

      if (!isIpAllowlisted(request.ip, config.security.allowlistSubnets)) {
        logger.warn("ws.forbidden.ip", {
          ip: request.ip,
          allowlist: config.security.allowlistSubnets
        });
        socket.send(
          JSON.stringify(
            errorEnvelope("FORBIDDEN", "IP is not allowlisted", null, {
              ip: request.ip
            })
          )
        );
        socket.close(1008, "Forbidden");
        return;
      }

      const sessionId = randomUUID();
      const now = nowEpochMs();

      const session: SessionState = {
        sessionId,
        socket,
        connectedAt: now,
        lastSeen: now,
        instanceId: randomUUID(),
        clientId: `anonymous-${sessionId.slice(0, 8)}`,
        version: "0.0.0",
        provides: [],
        consumes: [],
        tags: [],
        subscriptions: new Map(),
        stateWatches: new Map(),
        recentIds: new Map(),
        queue: [],
        queueBytes: 0,
        ip: request.ip,
        rateWindowMinute: minuteWindow(now),
        rateWindowCount: 0
      };

      sessions.set(session.sessionId, session);

      logger.info("ws.connected", {
        sessionId: session.sessionId,
        clientId: session.clientId,
        ip: session.ip
      });

      socket.on("pong", () => {
        session.lastSeen = nowEpochMs();
      });

      socket.on("message", (raw: RawData) => {
        session.lastSeen = nowEpochMs();
        handleSocketMessage(session, raw.toString("utf8"));
      });

      socket.on("close", () => {
        onSessionClosed(session.sessionId);
      });

      socket.on("error", (error: Error) => {
        logger.warn("ws.error", {
          sessionId: session.sessionId,
          clientId: session.clientId,
          error: error.message
        });
      });
    }
  );

  const heartbeatTimer = setInterval(() => {
    const now = nowEpochMs();

    for (const session of sessions.values()) {
      if (now - session.lastSeen > config.limits.heartbeatTimeoutMs) {
        logger.warn("ws.timeout", {
          sessionId: session.sessionId,
          clientId: session.clientId
        });
        session.socket.close(1001, "Heartbeat timeout");
        continue;
      }

      if (session.socket.readyState === WebSocket.OPEN) {
        session.socket.ping();
      }
    }
  }, config.limits.heartbeatIntervalMs);

  const queueFlushTimer = setInterval(() => {
    for (const session of sessions.values()) {
      flushSessionQueue(session);
    }
  }, 50);

  const retentionTimer = setInterval(() => {
    persistence.vacuumAudit(nowEpochMs());
  }, 60 * 60 * 1000);

  app.addHook("onClose", async () => {
    clearInterval(heartbeatTimer);
    clearInterval(queueFlushTimer);
    clearInterval(retentionTimer);

    for (const pending of pendingRpc.values()) {
      clearTimeout(pending.timeout);
    }
    pendingRpc.clear();

    for (const pending of pendingHttpRpc.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Hub shutting down"));
    }
    pendingHttpRpc.clear();

    persistence.close();
  });

  function authorizeHttp(request: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void): void {
    if (!isIpAllowlisted(request.ip, config.security.allowlistSubnets)) {
      reply.code(403).send({ error: hubError("FORBIDDEN", "IP is not allowlisted") });
      return done(new Error("forbidden"));
    }

    const result = authorizeTokenForRequest(request);
    if (!result.ok) {
      reply.code(401).send({ error: hubError("AUTH_REQUIRED", result.reason) });
      return done(new Error("unauthorized"));
    }

    done();
  }

  function authorizeTokenForRequest(request: Pick<FastifyRequest, "headers" | "url">): { ok: true } | { ok: false; reason: string } {
    if (!config.security.token) {
      return { ok: true };
    }

    const fromHeader = request.headers["x-hub-token"];
    const headerToken = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;

    const parsed = new URL(request.url, "http://localhost");
    const queryToken = parsed.searchParams.get("token") ?? undefined;

    if (headerToken === config.security.token || queryToken === config.security.token) {
      return { ok: true };
    }

    return { ok: false, reason: "Missing or invalid hub token" };
  }

  function handleSocketMessage(session: SessionState, raw: string): void {
    if (!incrementSessionRate(session)) {
      const response = errorEnvelope("RATE_LIMIT", "Rate limit exceeded", session.clientId, { clientId: session.clientId });
      enqueueForSession(session, response, true);
      return;
    }

    if (raw.length > config.limits.maxMessageSizeBytes) {
      const response = errorEnvelope("MESSAGE_TOO_LARGE", "Message exceeds max payload size", session.clientId, {
        clientId: session.clientId
      });
      enqueueForSession(session, response, true);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const response = errorEnvelope("INVALID_JSON", "Message is not valid JSON", session.clientId, { clientId: session.clientId });
      enqueueForSession(session, response, true);
      return;
    }

    const envelopeResult = HubEnvelopeSchema.safeParse(parsed);
    if (!envelopeResult.success) {
      const response = errorEnvelope("INVALID_ENVELOPE", "Message does not match envelope schema", session.clientId, {
        clientId: session.clientId,
        issues: envelopeResult.error.issues
      });
      enqueueForSession(session, response, true);
      return;
    }

    const envelope = envelopeResult.data;

    if (isDuplicateMessage(session, envelope.id)) {
      return;
    }

    metrics.messagesIn[envelope.type] += 1;
    bumpTopic(envelope.name);

    pushInspector("in", session.sessionId, envelope);

    const contractValidation = contractRegistry.validate(envelope.name, envelope.schemaVersion, envelope.payload);
    if (!contractValidation.ok) {
      const details = {
        name: envelope.name,
        schemaVersion: envelope.schemaVersion,
        issues: contractValidation.issues
      };

      if (config.validation.mode === "reject") {
        const response = errorEnvelope("PAYLOAD_VALIDATION_FAILED", "Payload validation failed", session.clientId, details, envelope.correlationId);
        enqueueForSession(session, response, true);
        return;
      }

      logger.warn("payload.validation.warn", {
        sessionId: session.sessionId,
        clientId: session.clientId,
        ...details
      });
    }

    routeMessage(session, envelope);
  }

  function routeMessage(session: SessionState | null, envelope: HubEnvelope): void {
    switch (envelope.type) {
      case "presence":
        if (!session) {
          return;
        }
        handlePresence(session, envelope);
        return;
      case "event":
      case "cmd":
        if (envelope.name === "subscribe") {
          if (!session) {
            return;
          }
          handleSubscribe(session, envelope);
          return;
        }
        if (envelope.name === "unsubscribe") {
          if (!session) {
            return;
          }
          handleUnsubscribe(session, envelope);
          return;
        }
        if (envelope.name === "state_set") {
          if (!session) {
            return;
          }
          handleStateSet(session, envelope);
          return;
        }
        if (envelope.name === "state_patch") {
          if (!session) {
            return;
          }
          handleStatePatch(session, envelope);
          return;
        }
        if (envelope.name === "state_watch") {
          if (!session) {
            return;
          }
          handleStateWatch(session, envelope);
          return;
        }
        if (envelope.name === "state_unwatch") {
          if (!session) {
            return;
          }
          handleStateUnwatch(session, envelope);
          return;
        }

        routePublishLike(session, envelope);
        return;
      case "rpc_req":
        routeRpcRequest(session, envelope);
        return;
      case "rpc_res":
        routeRpcResponse(session, envelope);
        return;
      case "state_patch":
        if (!session) {
          return;
        }
        routePublishLike(session, envelope);
        return;
      case "error":
        logger.warn("client.error", {
          sessionId: session?.sessionId,
          clientId: session?.clientId,
          payload: envelope.payload
        });
        return;
      default:
        return;
    }
  }

  function handlePresence(session: SessionState, envelope: HubEnvelope): void {
    const parsed = PresencePayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      enqueueForSession(
        session,
        errorEnvelope("INVALID_PRESENCE", "presence payload is invalid", session.clientId, parsed.error.issues, envelope.correlationId),
        true
      );
      return;
    }

    const payload = parsed.data;

    if (clientSessionHistory.has(payload.clientId) && clientSessionHistory.get(payload.clientId) !== session.sessionId) {
      metrics.reconnectCount += 1;
    }
    clientSessionHistory.set(payload.clientId, session.sessionId);

    detachSessionFromIndexes(session);

    session.clientId = payload.clientId;
    session.serviceName = payload.serviceName;
    session.version = payload.version;
    session.provides = payload.provides;
    session.consumes = payload.consumes;
    session.tags = payload.tags;
    session.lastSeen = nowEpochMs();

    if (!sessionIdsByClient.has(session.clientId)) {
      sessionIdsByClient.set(session.clientId, new Set());
    }
    sessionIdsByClient.get(session.clientId)!.add(session.sessionId);

    if (session.serviceName) {
      if (!providerSessionIds.has(session.serviceName)) {
        providerSessionIds.set(session.serviceName, new Set());
      }
      providerSessionIds.get(session.serviceName)!.add(session.sessionId);

      const record: PresenceRecord = {
        serviceName: session.serviceName,
        clientId: session.clientId,
        instanceId: session.instanceId,
        sessionId: session.sessionId,
        provides: session.provides,
        consumes: session.consumes,
        tags: session.tags,
        version: session.version,
        lastSeenTs: session.lastSeen,
        online: true
      };

      presenceByServiceInstance.set(`${record.serviceName}::${record.instanceId}`, record);
      persistence.upsertPresence(record);
    }

    logger.info("presence.upsert", {
      sessionId: session.sessionId,
      clientId: session.clientId,
      serviceName: session.serviceName,
      provides: session.provides,
      consumes: session.consumes,
      tags: session.tags
    });
  }

  function handleSubscribe(session: SessionState, envelope: HubEnvelope): void {
    const payload = envelope.payload as { subscriptionId?: string; names?: string[]; namePrefix?: string };
    const subscriptionId = typeof payload.subscriptionId === "string" ? payload.subscriptionId : randomUUID();

    const parsed = SubscribePayloadSchema.safeParse({ names: payload.names, namePrefix: payload.namePrefix });
    if (!parsed.success) {
      enqueueForSession(
        session,
        errorEnvelope("INVALID_SUBSCRIBE", "subscribe payload invalid", session.clientId, parsed.error.issues, envelope.correlationId),
        true
      );
      return;
    }

    session.subscriptions.set(subscriptionId, parsed.data);

    if (config.logging.routeDebug) {
      logger.debug("subscription.added", {
        sessionId: session.sessionId,
        clientId: session.clientId,
        subscriptionId,
        filter: parsed.data
      });
    }
  }

  function handleUnsubscribe(session: SessionState, envelope: HubEnvelope): void {
    const payload = envelope.payload as { subscriptionId?: string };
    if (!payload.subscriptionId) {
      return;
    }

    session.subscriptions.delete(payload.subscriptionId);
  }

  function handleStateSet(session: SessionState, envelope: HubEnvelope): void {
    const parsed = StateSetPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      enqueueForSession(
        session,
        errorEnvelope("INVALID_STATE_SET", "state_set payload invalid", session.clientId, parsed.error.issues, envelope.correlationId),
        true
      );
      return;
    }

    const mutation = stateStore.set(parsed.data.path, parsed.data.value);
    persistence.saveStateSnapshot(mutation.path, mutation.value, nowEpochMs());
    broadcastStatePatch(mutation.path, mutation.value, envelope.source);
  }

  function handleStatePatch(session: SessionState, envelope: HubEnvelope): void {
    const parsed = StatePatchPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      enqueueForSession(
        session,
        errorEnvelope("INVALID_STATE_PATCH", "state_patch payload invalid", session.clientId, parsed.error.issues, envelope.correlationId),
        true
      );
      return;
    }

    const mutation = stateStore.patch(parsed.data.path, parsed.data.patch);
    persistence.saveStateSnapshot(mutation.path, mutation.value, nowEpochMs());
    broadcastStatePatch(mutation.path, mutation.value, envelope.source);
  }

  function handleStateWatch(session: SessionState, envelope: HubEnvelope): void {
    const payload = envelope.payload as { watchId?: string; prefix?: string };
    if (!payload.watchId || !payload.prefix) {
      enqueueForSession(
        session,
        errorEnvelope("INVALID_STATE_WATCH", "state_watch requires watchId and prefix", session.clientId, envelope.payload, envelope.correlationId),
        true
      );
      return;
    }

    session.stateWatches.set(payload.watchId, normalizeStatePath(payload.prefix));
  }

  function handleStateUnwatch(session: SessionState, envelope: HubEnvelope): void {
    const payload = envelope.payload as { watchId?: string };
    if (!payload.watchId) {
      return;
    }
    session.stateWatches.delete(payload.watchId);
  }

  function routePublishLike(sourceSession: SessionState | null, envelope: HubEnvelope): void {
    const recipients = resolveRecipientsForPublish(envelope, sourceSession?.sessionId);
    for (const recipient of recipients) {
      enqueueForSession(recipient, envelope, false);
    }
  }

  function routeRpcRequest(sourceSession: SessionState | null, envelope: HubEnvelope): void {
    const payload = RpcRequestPayloadSchema.safeParse(envelope.payload);
    if (!payload.success) {
      if (sourceSession) {
        enqueueForSession(
          sourceSession,
          createRpcResponseEnvelope(
            envelope,
            {
              ok: false,
              error: hubError("INVALID_RPC", "Invalid rpc_req payload", payload.error.issues)
            },
            sourceSession.clientId
          ),
          true
        );
      }
      return;
    }

    const method = payload.data.method;

    if (isHubTarget(envelope.target)) {
      handleHubRpc(sourceSession, envelope, method, payload.data);
      return;
    }

    const targetService = extractServiceTarget(envelope.target);
    if (!targetService) {
      if (sourceSession) {
        enqueueForSession(
          sourceSession,
          createRpcResponseEnvelope(
            envelope,
            {
              ok: false,
              error: hubError("RPC_TARGET_REQUIRED", "rpc_req requires target serviceName")
            },
            sourceSession.clientId
          ),
          true
        );
      }
      return;
    }

    const provider = pickProviderSession(targetService);
    if (!provider) {
      if (sourceSession) {
        enqueueForSession(
          sourceSession,
          createRpcResponseEnvelope(
            envelope,
            {
              ok: false,
              error: hubError("SERVICE_UNAVAILABLE", `No provider for service ${targetService}`)
            },
            sourceSession.clientId
          ),
          true
        );
      } else if (envelope.correlationId && pendingHttpRpc.has(envelope.correlationId)) {
        const pending = pendingHttpRpc.get(envelope.correlationId)!;
        clearTimeout(pending.timeout);
        pendingHttpRpc.delete(envelope.correlationId);
        pending.resolve({
          ok: false,
          error: hubError("SERVICE_UNAVAILABLE", `No provider for service ${targetService}`)
        });
      }
      return;
    }

    if (!envelope.correlationId) {
      if (sourceSession) {
        enqueueForSession(
          sourceSession,
          errorEnvelope("RPC_CORRELATION_REQUIRED", "rpc_req missing correlationId", sourceSession.clientId),
          true
        );
      }
      return;
    }

    if (sourceSession) {
      const timeout = setTimeout(() => {
        pendingRpc.delete(envelope.correlationId!);

        const timeoutResponse: RpcResponsePayload = {
          ok: false,
          error: hubError("RPC_TIMEOUT", `RPC timeout for ${targetService}.${method}`)
        };

        enqueueForSession(sourceSession, createRpcResponseEnvelope(envelope, timeoutResponse, sourceSession.clientId), true);
      }, payload.data.timeoutMs);

      pendingRpc.set(envelope.correlationId, {
        fromSessionId: sourceSession.sessionId,
        startedAt: nowEpochMs(),
        timeout
      });
    }

    enqueueForSession(provider, envelope, true);
  }

  function routeRpcResponse(sourceSession: SessionState | null, envelope: HubEnvelope): void {
    if (!envelope.correlationId) {
      return;
    }

    const parsed = RpcResponsePayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      return;
    }

    const pendingWs = pendingRpc.get(envelope.correlationId);
    if (pendingWs) {
      clearTimeout(pendingWs.timeout);
      pendingRpc.delete(envelope.correlationId);
      const requester = sessions.get(pendingWs.fromSessionId);
      if (requester) {
        enqueueForSession(requester, envelope, true);
      }
      pushRpcLatency(nowEpochMs() - pendingWs.startedAt);
      return;
    }

    const pendingHttp = pendingHttpRpc.get(envelope.correlationId);
    if (pendingHttp) {
      clearTimeout(pendingHttp.timeout);
      pendingHttpRpc.delete(envelope.correlationId);
      pendingHttp.resolve(parsed.data);
      pushRpcLatency(nowEpochMs() - pendingHttp.startedAt);
      return;
    }

    if (sourceSession && config.logging.routeDebug) {
      logger.debug("rpc.res.unmatched", {
        sessionId: sourceSession.sessionId,
        correlationId: envelope.correlationId
      });
    }
  }

  function handleHubRpc(
    sourceSession: SessionState | null,
    envelope: HubEnvelope,
    method: string,
    payload: RpcRequestPayload
  ): void {
    const respond = (responsePayload: RpcResponsePayload): void => {
      if (sourceSession) {
        enqueueForSession(sourceSession, createRpcResponseEnvelope(envelope, responsePayload, sourceSession.clientId), true);
        return;
      }

      if (!envelope.correlationId) {
        return;
      }

      const pending = pendingHttpRpc.get(envelope.correlationId);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      pendingHttpRpc.delete(envelope.correlationId);
      pending.resolve(responsePayload);
    };

    switch (method) {
      case "state_get": {
        const path = (payload.args as { path?: string })?.path;
        if (!path) {
          respond({
            ok: false,
            error: hubError("INVALID_ARGS", "state_get requires args.path")
          });
          return;
        }
        respond({
          ok: true,
          result: stateStore.get(path)
        });
        return;
      }
      default:
        respond({
          ok: false,
          error: hubError("METHOD_NOT_FOUND", `Unknown hub rpc method: ${method}`)
        });
    }
  }

  function broadcastStatePatch(path: string, value: unknown, source: HubEnvelope["source"]): void {
    const envelope = createEnvelope({
      type: "state_patch",
      name: "state.patch",
      source,
      target: "*",
      schemaVersion: 1,
      payload: {
        path,
        value
      }
    });

    for (const session of sessions.values()) {
      if (!matchesStateWatch(session, path)) {
        continue;
      }
      enqueueForSession(session, envelope, false);
    }
  }

  function enqueueForSession(session: SessionState, envelope: HubEnvelope, critical: boolean): void {
    if (session.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const raw = JSON.stringify(envelope);
    const bytes = Buffer.byteLength(raw, "utf8");
    if (bytes > config.limits.maxMessageSizeBytes) {
      metrics.droppedMessages += 1;
      pushInspector("drop", session.sessionId, envelope, "message too large outbound");
      return;
    }

    const shouldQueue = session.queue.length > 0 || session.socket.bufferedAmount > config.limits.maxSessionBufferedBytes / 2;

    if (!shouldQueue) {
      try {
        session.socket.send(raw);
        metrics.messagesOut[envelope.type] += 1;
        pushInspector("out", session.sessionId, envelope);
        return;
      } catch {
        // Fall through to queue.
      }
    }

    const item: SessionQueueItem = {
      raw,
      envelope,
      bytes,
      critical
    };

    while (
      session.queue.length >= config.limits.maxSessionBufferMessages ||
      session.queueBytes + bytes > config.limits.maxSessionBufferedBytes
    ) {
      if (session.queue.length === 0) {
        break;
      }

      const dropped = session.queue.shift()!;
      session.queueBytes -= dropped.bytes;
      metrics.droppedMessages += 1;
      pushInspector("drop", session.sessionId, dropped.envelope, "buffer backpressure");

      if (critical) {
        const criticalError = errorEnvelope(
          "BACKPRESSURE",
          "Unable to deliver critical message due to backpressure",
          session.clientId,
          { sessionId: session.sessionId }
        );
        try {
          session.socket.send(JSON.stringify(criticalError));
        } catch {
          // Ignore final fallback errors.
        }
        return;
      }
    }

    session.queue.push(item);
    session.queueBytes += bytes;
  }

  function flushSessionQueue(session: SessionState): void {
    if (session.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    while (session.queue.length > 0 && session.socket.bufferedAmount < config.limits.maxSessionBufferedBytes / 2) {
      const item = session.queue.shift()!;
      session.queueBytes -= item.bytes;
      try {
        session.socket.send(item.raw);
        metrics.messagesOut[item.envelope.type] += 1;
        pushInspector("out", session.sessionId, item.envelope);
      } catch {
        metrics.droppedMessages += 1;
        pushInspector("drop", session.sessionId, item.envelope, "socket send failure");
      }
    }
  }

  function onSessionClosed(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }

    sessions.delete(sessionId);
    detachSessionFromIndexes(session);

    if (session.serviceName) {
      const key = `${session.serviceName}::${session.instanceId}`;
      const record = presenceByServiceInstance.get(key);
      if (record) {
        record.online = false;
        record.lastSeenTs = nowEpochMs();
        record.sessionId = session.sessionId;
        presenceByServiceInstance.set(key, record);
        persistence.upsertPresence(record);
      }
    }

    logger.info("ws.disconnected", {
      sessionId: session.sessionId,
      clientId: session.clientId,
      serviceName: session.serviceName
    });
  }

  function detachSessionFromIndexes(session: SessionState): void {
    const byClient = sessionIdsByClient.get(session.clientId);
    if (byClient) {
      byClient.delete(session.sessionId);
      if (byClient.size === 0) {
        sessionIdsByClient.delete(session.clientId);
      }
    }

    if (session.serviceName) {
      const providers = providerSessionIds.get(session.serviceName);
      if (providers) {
        providers.delete(session.sessionId);
        if (providers.size === 0) {
          providerSessionIds.delete(session.serviceName);
          roundRobinCursor.delete(session.serviceName);
        }
      }
    }
  }

  function resolveRecipientsForPublish(envelope: HubEnvelope, excludeSessionId?: string): SessionState[] {
    if (envelope.target === "*") {
      const recipients = Array.from(sessions.values()).filter((session) => {
        if (session.sessionId === excludeSessionId) {
          return false;
        }
        return matchesSubscription(session, envelope.name);
      });
      return recipients;
    }

    if (envelope.target.clientId) {
      const sessionIds = sessionIdsByClient.get(envelope.target.clientId);
      if (!sessionIds) {
        return [];
      }
      return Array.from(sessionIds)
        .map((id) => sessions.get(id))
        .filter((session): session is SessionState => Boolean(session && session.sessionId !== excludeSessionId));
    }

    if (envelope.target.serviceName) {
      const sessionIds = providerSessionIds.get(envelope.target.serviceName);
      if (!sessionIds) {
        return [];
      }
      return Array.from(sessionIds)
        .map((id) => sessions.get(id))
        .filter((session): session is SessionState => Boolean(session && session.sessionId !== excludeSessionId));
    }

    return [];
  }

  function pickProviderSession(serviceName: string): SessionState | null {
    const providerIds = providerSessionIds.get(serviceName);
    if (!providerIds || providerIds.size === 0) {
      return null;
    }

    const online = Array.from(providerIds)
      .map((id) => sessions.get(id))
      .filter((session): session is SessionState => Boolean(session));

    if (online.length === 0) {
      return null;
    }

    const cursor = roundRobinCursor.get(serviceName) ?? 0;
    const selected = online[cursor % online.length];
    roundRobinCursor.set(serviceName, (cursor + 1) % online.length);
    return selected;
  }

  function createEnvelope(input: {
    type: HubMessageType;
    name: string;
    source: HubEnvelope["source"];
    target: HubTarget;
    payload: unknown;
    schemaVersion: number;
    correlationId?: string;
  }): HubEnvelope {
    return {
      v: 1,
      id: randomUUID(),
      type: input.type,
      name: input.name,
      source: input.source,
      target: input.target,
      ts: nowEpochMs(),
      correlationId: input.correlationId,
      schemaVersion: input.schemaVersion,
      payload: input.payload
    };
  }

  function createRpcResponseEnvelope(request: HubEnvelope, payload: RpcResponsePayload, targetClientId: string): HubEnvelope {
    return createEnvelope({
      type: "rpc_res",
      name: request.name,
      source: {
        clientId: "hub",
        serviceName: "hub"
      },
      target: {
        clientId: targetClientId
      },
      schemaVersion: 1,
      correlationId: request.correlationId,
      payload
    });
  }

  function errorEnvelope(
    code: string,
    message: string,
    clientId: string | null,
    details?: unknown,
    correlationId?: string
  ): HubEnvelope {
    return createEnvelope({
      type: "error",
      name: "error",
      source: {
        clientId: "hub",
        serviceName: "hub"
      },
      target: clientId ? { clientId } : "*",
      schemaVersion: 1,
      correlationId,
      payload: hubError(code, message, details)
    });
  }

  function pushInspector(direction: Direction, sessionId: string, envelope: HubEnvelope, reason?: string): void {
    inspector.push({
      ts: nowEpochMs(),
      direction,
      sessionId,
      envelope,
      reason
    });

    if (inspector.length > config.limits.inspectorMaxMessages) {
      inspector.splice(0, inspector.length - config.limits.inspectorMaxMessages);
    }
  }

  function bumpTopic(name: string): void {
    messageNameCounter.set(name, (messageNameCounter.get(name) ?? 0) + 1);
  }

  function incrementSessionRate(session: SessionState): boolean {
    const currentMinute = minuteWindow(nowEpochMs());
    if (session.rateWindowMinute !== currentMinute) {
      session.rateWindowMinute = currentMinute;
      session.rateWindowCount = 0;
    }

    session.rateWindowCount += 1;
    return session.rateWindowCount <= config.limits.rateLimitPerMinute;
  }

  function isDuplicateMessage(session: SessionState, messageId: string): boolean {
    const now = nowEpochMs();

    for (const [id, ts] of session.recentIds.entries()) {
      if (now - ts > config.limits.dedupWindowMs) {
        session.recentIds.delete(id);
      }
    }

    if (session.recentIds.has(messageId)) {
      return true;
    }

    session.recentIds.set(messageId, now);
    return false;
  }

  function matchesSubscription(session: SessionState, messageName: string): boolean {
    if (session.subscriptions.size === 0) {
      return false;
    }

    for (const subscription of session.subscriptions.values()) {
      if (subscription.names?.includes(messageName)) {
        return true;
      }
      if (subscription.namePrefix && messageName.startsWith(subscription.namePrefix)) {
        return true;
      }
    }

    return false;
  }

  function matchesStateWatch(session: SessionState, statePath: string): boolean {
    if (session.stateWatches.size === 0) {
      return false;
    }

    for (const prefix of session.stateWatches.values()) {
      if (statePath.startsWith(prefix)) {
        return true;
      }
    }

    return false;
  }

  function pushRpcLatency(latencyMs: number): void {
    metrics.rpcLatenciesMs.push(latencyMs);
    if (metrics.rpcLatenciesMs.length > 5000) {
      metrics.rpcLatenciesMs.splice(0, metrics.rpcLatenciesMs.length - 5000);
    }
  }

  function closeAllSessions(): void {
    for (const session of sessions.values()) {
      session.socket.close(1001, "Hub shutdown");
    }
    sessions.clear();
  }

  const runtime: HubRuntime = {
    app,
    close: async () => {
      closeAllSessions();
      await app.close();
    }
  };

  return runtime;
}

function extractServiceTarget(target: HubTarget): string | null {
  if (target === "*") {
    return null;
  }
  return target.serviceName ?? null;
}

function isHubTarget(target: HubTarget): boolean {
  if (target === "*") {
    return false;
  }

  return target.serviceName === "hub";
}

function normalizeStatePath(path: string): string {
  if (path.startsWith("state/")) {
    return path;
  }
  return `state/${path.replace(/^\/+/, "")}`;
}

function pathExists(pathToCheck: string): boolean {
  return fs.existsSync(pathToCheck);
}

function serveStaticFromDir(
  reply: FastifyReply,
  rootDir: string,
  wildcardPath: string,
  defaultFile: string
): boolean {
  const resolvedRoot = path.resolve(rootDir);
  const relativePathRaw = wildcardPath || "";
  const relativePathDecoded = decodeURIComponent(relativePathRaw);
  let relativePath = relativePathDecoded;

  if (!relativePath || relativePath.endsWith("/")) {
    relativePath = `${relativePath}${defaultFile}`;
  }

  relativePath = relativePath.replace(/^\/+/, "");
  const resolvedFile = path.resolve(resolvedRoot, relativePath);

  if (!isPathWithinRoot(resolvedRoot, resolvedFile)) {
    reply.code(403).send({ error: hubError("FORBIDDEN", "Invalid static asset path") });
    return true;
  }

  if (!pathExists(resolvedFile)) {
    return false;
  }

  let finalFile = resolvedFile;
  const stat = fs.statSync(finalFile);
  if (stat.isDirectory()) {
    finalFile = path.join(finalFile, defaultFile);
  }

  if (!pathExists(finalFile)) {
    return false;
  }

  const body = fs.readFileSync(finalFile);
  reply.header("Cache-Control", "no-store");
  reply.type(contentTypeForFile(finalFile));
  reply.send(body);
  return true;
}

function isPathWithinRoot(rootDir: string, filePath: string): boolean {
  const normalizedRoot = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
  return filePath === rootDir || filePath.startsWith(normalizedRoot);
}

function contentTypeForFile(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function minuteWindow(ts: number): number {
  return Math.floor(ts / 60000);
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.floor((percentileValue / 100) * sortedValues.length) - 1)
  );

  return sortedValues[index] ?? 0;
}

function isIpAllowlisted(ip: string, allowlist: string[]): boolean {
  if (allowlist.length === 0 || allowlist.includes("*")) {
    return true;
  }

  const normalizedIp = normalizeClientIp(ip);
  if (!normalizedIp) {
    return false;
  }

  let parsedIp: ReturnType<typeof ipaddr.parse>;

  try {
    parsedIp = ipaddr.parse(normalizedIp);
  } catch {
    return false;
  }

  for (const entry of allowlist) {
    const normalizedEntry = entry.replace(/^::ffff:/, "");
    try {
      const candidateIp =
        parsedIp.kind() === "ipv6" &&
        "isIPv4MappedAddress" in parsedIp &&
        typeof parsedIp.isIPv4MappedAddress === "function" &&
        parsedIp.isIPv4MappedAddress()
          ? parsedIp.toIPv4Address()
          : parsedIp;

      if (normalizedEntry.includes("/")) {
        const range = ipaddr.parseCIDR(normalizedEntry);
        const networkAddress = range[0];
        const prefix = range[1];
        if (candidateIp.kind() !== networkAddress.kind()) {
          continue;
        }
        if (candidateIp.match([networkAddress, prefix])) {
          return true;
        }
      } else if (candidateIp.toString() === ipaddr.parse(normalizedEntry).toString()) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

function normalizeClientIp(ip: string): string | null {
  let value = ip.split(",")[0]?.trim() ?? "";
  if (!value) {
    return null;
  }

  if (value.startsWith("[") && value.includes("]")) {
    value = value.slice(1, value.indexOf("]"));
  }

  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(":"));
  }

  value = value.replace(/^::ffff:/, "");
  if (value.includes("%")) {
    value = value.slice(0, value.indexOf("%"));
  }

  return value || null;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
