import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HubClient } from "@superhub/sdk";

type IssPosition = {
  lat: number;
  lon: number;
  altKm: number;
  at: number;
};

const hubHttpUrl = (process.env.HUB_HTTP_URL || "https://mac-mini-de-olivier.local").replace(/\/$/, "");
const useTls = hubHttpUrl.startsWith("https://");
const tlsInsecure = ["1", "true", "yes", "on"].includes((process.env.HUB_TLS_INSECURE || "").toLowerCase());
const defaultCaddyCaFile = path.join(
  homedir(),
  "Library",
  "Application Support",
  "Caddy",
  "pki",
  "authorities",
  "local",
  "root.crt"
);
const tlsCaFile = process.env.HUB_TLS_CA_FILE || (existsSync(defaultCaddyCaFile) ? defaultCaddyCaFile : undefined);

const client = new HubClient({
  httpUrl: hubHttpUrl,
  token: process.env.HUB_TOKEN,
  tls: useTls
    ? {
        caFile: tlsCaFile,
        rejectUnauthorized: !tlsInsecure
      }
    : undefined,
  clientId: process.env.CLIENT_ID || randomUUID(),
  serviceName: "iss-monitor",
  version: "0.1.0",
  provides: [],
  consumes: ["iss.*"],
  tags: ["example", "node", "monitor"],
  debug: true
});

if (useTls && !tlsCaFile && !tlsInsecure) {
  console.warn(
    "TLS verify is enabled without HUB_TLS_CA_FILE. If Caddy local CA is not trusted by Node, set HUB_TLS_CA_FILE."
  );
}

if (useTls && tlsCaFile) {
  console.log(`Using TLS CA file: ${tlsCaFile}`);
}

let unsubscribeEvents: (() => void) | null = null;
let unwatchState: (() => void) | null = null;

client.onOpen(() => {
  console.log("iss-monitor connected");

  unsubscribeEvents = client.subscribe({ names: ["iss.position"] }, (message) => {
    const position = asIssPosition(message.payload);
    if (position) {
      logIssPosition("event", position);
      return;
    }
    console.log("[event] iss.position (raw)", message.payload);
  });

  unwatchState = client.watchState("state/iss/position", (_path, value) => {
    const position = asIssPosition(value);
    if (position) {
      logIssPosition("state", position);
      return;
    }
    console.log("[state] state/iss/position (raw)", value);
  });
});

client.onError((error) => {
  console.error("iss-monitor error", error);
});

client.onClose(() => {
  console.log("iss-monitor disconnected");
});

process.on("SIGINT", () => {
  if (unsubscribeEvents) {
    unsubscribeEvents();
  }
  if (unwatchState) {
    unwatchState();
  }
  client.disconnect();
  process.exit(0);
});

void client.connect();

function asIssPosition(value: unknown): IssPosition | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<IssPosition>;
  if (
    typeof candidate.lat !== "number" ||
    typeof candidate.lon !== "number" ||
    typeof candidate.altKm !== "number" ||
    typeof candidate.at !== "number"
  ) {
    return null;
  }

  if (
    !Number.isFinite(candidate.lat) ||
    !Number.isFinite(candidate.lon) ||
    !Number.isFinite(candidate.altKm) ||
    !Number.isFinite(candidate.at)
  ) {
    return null;
  }

  return candidate as IssPosition;
}

function logIssPosition(source: "event" | "state", position: IssPosition): void {
  const at = new Date(position.at).toISOString();
  console.log(
    `[${source}] ISS lat=${position.lat.toFixed(4)} lon=${position.lon.toFixed(4)} altKm=${position.altKm.toFixed(2)} at=${at}`
  );
}
