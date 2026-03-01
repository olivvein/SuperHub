import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

const config = {
  domain: "hub.local",
  listen: {
    host: "127.0.0.1",
    port: 7777
  },
  security: {
    token: process.env.HUB_TOKEN || "CHANGE_ME_SUPERHUB_TOKEN",
    pairingEnabled: true,
    allowlistSubnets: ["127.0.0.1/32", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"]
  },
  cors: {
    origins: ["https://hub.local"],
    allowHeaders: ["Content-Type", "X-Hub-Token"]
  },
  limits: {
    maxMessageSizeBytes: 256 * 1024,
    maxSessionBufferMessages: 400,
    maxSessionBufferedBytes: 1024 * 1024,
    dedupWindowMs: 10_000,
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    inspectorMaxMessages: 500,
    rateLimitPerMinute: 1_800
  },
  validation: {
    mode: process.env.NODE_ENV === "production" ? "warn" : "reject"
  },
  logging: {
    level: "info" as const,
    routeDebug: false
  },
  persistence: {
    enabled: true,
    sqlitePath: path.resolve(repoRoot, "packages/hub/data/hub.sqlite"),
    auditEnabled: true,
    auditTtlDays: 14
  },
  staticHosting: {
    consoleDir: path.resolve(repoRoot, "packages/hub/public/console"),
    appsDir: path.resolve(repoRoot, "packages/hub/public/apps")
  }
};

export default config;
