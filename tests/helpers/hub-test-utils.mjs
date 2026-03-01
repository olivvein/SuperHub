import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { createHubRuntime } from "../../packages/hub/dist/hub.js";

const ROOT = new URL("../../", import.meta.url).pathname;

export async function startHubTestServer(overrides = {}) {
  const config = {
    domain: "hub.local",
    listen: {
      host: "127.0.0.1",
      port: 0
    },
    security: {
      token: "test-token",
      pairingEnabled: false,
      allowlistSubnets: ["127.0.0.1/32", "::1/128"]
    },
    cors: {
      origins: ["http://127.0.0.1"],
      allowHeaders: ["Content-Type", "X-Hub-Token"]
    },
    limits: {
      maxMessageSizeBytes: 256 * 1024,
      maxSessionBufferMessages: 50,
      maxSessionBufferedBytes: 512 * 1024,
      dedupWindowMs: 5000,
      heartbeatIntervalMs: 2000,
      heartbeatTimeoutMs: 6000,
      inspectorMaxMessages: 200,
      rateLimitPerMinute: 5000
    },
    validation: {
      mode: "reject"
    },
    logging: {
      level: "error",
      routeDebug: false
    },
    persistence: {
      enabled: false,
      sqlitePath: `${ROOT}packages/hub/data/test-hub.sqlite`,
      auditEnabled: false,
      auditTtlDays: 1
    },
    staticHosting: {
      consoleDir: `${ROOT}packages/hub/public/console`,
      appsDir: `${ROOT}packages/hub/public/apps`
    },
    ...overrides
  };

  const runtime = await createHubRuntime(config);
  await runtime.app.listen({ host: "127.0.0.1", port: 0 });

  const address = runtime.app.server.address();
  assert.ok(address && typeof address === "object" && "port" in address);

  const port = address.port;

  return {
    runtime,
    port,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws?token=test-token`,
    async stop() {
      await runtime.close();
    }
  };
}

export async function connectWsClient({ wsUrl, clientId, serviceName, provides = [], consumes = [] }) {
  const socket = new WebSocket(wsUrl);
  await onceOpen(socket);

  sendEnvelope(socket, {
    type: "presence",
    name: "presence",
    source: { clientId, serviceName },
    target: { serviceName: "hub" },
    schemaVersion: 1,
    payload: {
      clientId,
      serviceName,
      version: "test",
      provides,
      consumes,
      tags: ["test"]
    }
  });

  await delay(40);

  return socket;
}

export function sendEnvelope(socket, partial) {
  const envelope = {
    v: 1,
    id: randomUUID(),
    ts: Date.now(),
    ...partial
  };

  socket.send(JSON.stringify(envelope));
}

export async function waitForMessage(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket message"));
    }, timeoutMs);

    function onMessage(raw) {
      try {
        const message = JSON.parse(raw.toString("utf8"));
        if (predicate(message)) {
          cleanup();
          resolve(message);
        }
      } catch {
        // Ignore parse errors in tests.
      }
    }

    function onClose() {
      cleanup();
      reject(new Error("Socket closed while waiting for message"));
    }

    function cleanup() {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    }

    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    return;
  }

  await new Promise((resolve) => {
    socket.once("close", () => resolve());
    socket.close();
  });
}

function onceOpen(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting websocket open"));
    }, 2000);

    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });

    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
