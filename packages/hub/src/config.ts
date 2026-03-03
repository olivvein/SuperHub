import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import yaml from "js-yaml";
import { z } from "zod";

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const HubConfigSchema = z.object({
  domain: z.string().default("mac-mini-de-olivier.local"),
  listen: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(1).max(65535).default(7777)
    })
    .default({ host: "127.0.0.1", port: 7777 }),
  security: z
    .object({
      token: z.string().min(1).optional(),
      pairingEnabled: z.boolean().default(true),
      allowlistSubnets: z
        .array(z.string().min(1))
        .default(["127.0.0.1/32", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"])
    })
    .default({
      pairingEnabled: true,
      allowlistSubnets: ["127.0.0.1/32", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"]
    }),
  cors: z
    .object({
      origins: z.array(z.string()).default(["https://mac-mini-de-olivier.local"]),
      allowHeaders: z.array(z.string()).default(["Content-Type", "X-Hub-Token"])
    })
    .default({
      origins: ["https://mac-mini-de-olivier.local"],
      allowHeaders: ["Content-Type", "X-Hub-Token"]
    }),
  limits: z
    .object({
      maxMessageSizeBytes: z.number().int().positive().default(262144),
      maxSessionBufferMessages: z.number().int().positive().default(400),
      maxSessionBufferedBytes: z.number().int().positive().default(1048576),
      dedupWindowMs: z.number().int().positive().default(10000),
      heartbeatIntervalMs: z.number().int().positive().default(10000),
      heartbeatTimeoutMs: z.number().int().positive().default(30000),
      inspectorMaxMessages: z.number().int().positive().default(500),
      rateLimitPerMinute: z.number().int().nonnegative().default(120000)
    })
    .default({
      maxMessageSizeBytes: 262144,
      maxSessionBufferMessages: 400,
      maxSessionBufferedBytes: 1048576,
      dedupWindowMs: 10000,
      heartbeatIntervalMs: 10000,
      heartbeatTimeoutMs: 30000,
      inspectorMaxMessages: 500,
      rateLimitPerMinute: 120000
    }),
  validation: z
    .object({
      mode: z.enum(["reject", "warn"]).default(process.env.NODE_ENV === "production" ? "warn" : "reject")
    })
    .default({ mode: process.env.NODE_ENV === "production" ? "warn" : "reject" }),
  logging: z
    .object({
      level: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
      routeDebug: z.boolean().default(false)
    })
    .default({ level: "info", routeDebug: false }),
  persistence: z
    .object({
      enabled: z.boolean().default(true),
      sqlitePath: z.string().default(path.resolve(process.cwd(), "data/hub.sqlite")),
      auditEnabled: z.boolean().default(true),
      auditTtlDays: z.number().int().positive().default(14),
      stateSnapshotFlushMs: z.number().int().positive().default(250),
      maxPendingStateSnapshots: z.number().int().positive().default(5000)
    })
    .default({
      enabled: true,
      sqlitePath: path.resolve(process.cwd(), "data/hub.sqlite"),
      auditEnabled: true,
      auditTtlDays: 14,
      stateSnapshotFlushMs: 250,
      maxPendingStateSnapshots: 5000
    }),
  staticHosting: z
    .object({
      consoleDir: z.string().default(path.resolve(process.cwd(), "public/console")),
      appsDir: z.string().optional()
    })
    .default({
      consoleDir: path.resolve(process.cwd(), "public/console")
    })
});

export type HubConfig = z.infer<typeof HubConfigSchema>;

const CANDIDATE_CONFIGS = ["hub.config.ts", "hub.config.js", "hub.config.json", "hub.config.yaml", "hub.config.yml"];

export async function loadHubConfig(): Promise<HubConfig> {
  const defaults = HubConfigSchema.parse({});
  const fileConfig = await loadFromDisk();
  const envConfig = loadFromEnv(defaults);
  const merged = deepMerge(defaults, deepMerge(fileConfig.config, envConfig));
  return normalizePaths(HubConfigSchema.parse(merged), fileConfig.baseDir ?? process.cwd());
}

async function loadFromDisk(): Promise<{ config: Record<string, unknown>; baseDir: string | null }> {
  const candidateDirs = [process.cwd(), path.resolve(process.cwd(), ".."), path.resolve(process.cwd(), "../..")];

  for (const dir of candidateDirs) {
    for (const name of CANDIDATE_CONFIGS) {
      const absolute = path.join(dir, name);
      if (!fs.existsSync(absolute)) {
        continue;
      }

      try {
        if (name.endsWith(".json")) {
          return {
            config: JSON.parse(fs.readFileSync(absolute, "utf8")) as Record<string, unknown>,
            baseDir: dir
          };
        }

        if (name.endsWith(".yaml") || name.endsWith(".yml")) {
          return {
            config: ((yaml.load(fs.readFileSync(absolute, "utf8")) as Record<string, unknown>) ?? {}) as Record<
              string,
              unknown
            >,
            baseDir: dir
          };
        }

        const imported = await import(pathToFileURL(absolute).href);
        const config = (imported.default ?? imported) as Record<string, unknown>;
        return {
          config: config ?? {},
          baseDir: dir
        };
      } catch {
        continue;
      }
    }
  }

  return { config: {}, baseDir: null };
}

function loadFromEnv(defaults: HubConfig): Record<string, unknown> {
  const token = process.env.HUB_TOKEN;
  const domain = process.env.HUB_DOMAIN;
  const host = process.env.HUB_HOST;
  const port = toNumber(process.env.HUB_PORT);
  const level = process.env.HUB_LOG_LEVEL;
  const mode = process.env.HUB_VALIDATION_MODE;
  const sqlitePath = process.env.HUB_SQLITE_PATH;
  const allowlist = process.env.HUB_ALLOWLIST_SUBNETS;
  const corsOrigins = process.env.HUB_CORS_ORIGINS;
  const stateSnapshotFlushMs = toNumber(process.env.HUB_STATE_SNAPSHOT_FLUSH_MS);
  const maxPendingStateSnapshots = toNumber(process.env.HUB_MAX_PENDING_STATE_SNAPSHOTS);

  const envConfig: Record<string, unknown> = {
    domain,
    listen: {
      host,
      port
    },
    security: {
      token,
      allowlistSubnets: allowlist ? allowlist.split(",").map((item) => item.trim()).filter(Boolean) : undefined,
      pairingEnabled: toBoolean(process.env.HUB_PAIRING_ENABLED, defaults.security.pairingEnabled)
    },
    logging: {
      level,
      routeDebug: toBoolean(process.env.HUB_ROUTE_DEBUG, defaults.logging.routeDebug)
    },
    validation: {
      mode
    },
    persistence: {
      enabled: toBoolean(process.env.HUB_PERSISTENCE_ENABLED, defaults.persistence.enabled),
      sqlitePath,
      auditEnabled: toBoolean(process.env.HUB_AUDIT_ENABLED, defaults.persistence.auditEnabled),
      auditTtlDays: toNumber(process.env.HUB_AUDIT_TTL_DAYS),
      stateSnapshotFlushMs,
      maxPendingStateSnapshots
    },
    limits: {
      maxMessageSizeBytes: toNumber(process.env.HUB_MAX_MESSAGE_SIZE_BYTES),
      maxSessionBufferMessages: toNumber(process.env.HUB_MAX_SESSION_BUFFER_MESSAGES),
      maxSessionBufferedBytes: toNumber(process.env.HUB_MAX_SESSION_BUFFERED_BYTES),
      dedupWindowMs: toNumber(process.env.HUB_DEDUP_WINDOW_MS),
      heartbeatIntervalMs: toNumber(process.env.HUB_HEARTBEAT_INTERVAL_MS),
      heartbeatTimeoutMs: toNumber(process.env.HUB_HEARTBEAT_TIMEOUT_MS),
      inspectorMaxMessages: toNumber(process.env.HUB_INSPECTOR_MAX_MESSAGES),
      rateLimitPerMinute: toNumber(process.env.HUB_RATE_LIMIT_PER_MINUTE)
    },
    cors: {
      origins: corsOrigins ? corsOrigins.split(",").map((item) => item.trim()).filter(Boolean) : undefined,
      allowHeaders: defaults.cors.allowHeaders
    }
  };

  return pruneUndefined(envConfig);
}

function toNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function deepMerge<T extends object>(base: T, override: Record<string, unknown>): T {
  const output: Record<string, unknown> = { ...(base as Record<string, unknown>) };

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }

    const existing = output[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      output[key] = deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>);
      continue;
    }

    output[key] = value;
  }

  return output as T;
}

function pruneUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) {
      continue;
    }

    if (isPlainObject(value)) {
      const nested = pruneUndefined(value as Record<string, unknown>);
      if (Object.keys(nested).length > 0) {
        out[key] = nested;
      }
      continue;
    }

    out[key] = value;
  }

  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePaths(config: HubConfig, baseDir: string): HubConfig {
  const resolvePath = (value: string): string => (path.isAbsolute(value) ? value : path.resolve(baseDir, value));

  return {
    ...config,
    persistence: {
      ...config.persistence,
      sqlitePath: resolvePath(config.persistence.sqlitePath)
    },
    staticHosting: {
      ...config.staticHosting,
      consoleDir: resolvePath(config.staticHosting.consoleDir),
      appsDir: config.staticHosting.appsDir ? resolvePath(config.staticHosting.appsDir) : undefined
    }
  };
}
