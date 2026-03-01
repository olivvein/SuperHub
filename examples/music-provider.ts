import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HubClient } from "@superhub/sdk";

const hubHttpUrl = (process.env.HUB_HTTP_URL || "https://macbook-pro-de-olivier.local").replace(/\/$/, "");
const useTls = hubHttpUrl.startsWith("https://");
const tlsInsecure = ["1", "true", "yes", "on"].includes((process.env.HUB_TLS_INSECURE || "").toLowerCase());
const defaultCaddyCaFile = path.join(homedir(), "Library", "Application Support", "Caddy", "pki", "authorities", "local", "root.crt");
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
  serviceName: "music",
  version: "0.1.0",
  provides: ["music.play", "music.pause", "music.next"],
  consumes: ["music.*"],
  tags: ["example", "provider"],
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

client.onOpen(() => {
  console.log("music-provider connected");

  client.onRpc("music.play", async (args) => {
    const input = args as { trackId?: string; positionMs?: number } | undefined;
    const trackId = input?.trackId ?? "unknown-track";
    const positionMs = input?.positionMs ?? 0;

    console.log("rpc music.play", { trackId, positionMs });

    client.setState("state/music/current", {
      trackId,
      positionMs,
      startedAt: Date.now()
    });

    client.publish("music.played", { trackId, at: Date.now() }, "*");

    return {
      accepted: true,
      trackId,
      positionMs
    };
  });
});

client.onError((error) => {
  console.error("music-provider error", error);
});

client.onClose(() => {
  console.log("music-provider disconnected");
});

void client.connect();
