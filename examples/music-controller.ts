import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HubClient } from "@superhub/sdk";

const hubHttpUrl = (process.env.HUB_HTTP_URL || "https://mac-mini-de-olivier.local").replace(/\/$/, "");
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
  serviceName: "music-controller",
  provides: [],
  consumes: ["music.*"],
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

client.onOpen(async () => {
  console.log("controller connected");

  const unsubscribe = client.subscribe({ namePrefix: "music." }, (message) => {
    console.log("event", message.name, message.payload);
  });

  const rpcResponse = await client.rpc<{ accepted: boolean; trackId: string; positionMs: number }>(
    "music",
    "music.play",
    { trackId: "track-12", positionMs: 0 },
    5000
  );
  console.log("rpc response", rpcResponse);

  const stateUnwatch = client.watchState("state/music", (path, value) => {
    console.log("state patch", path, value);
  });

  client.setState("state/music/current", { trackId: "track-12", startedAt: Date.now() });

  setTimeout(() => {
    unsubscribe();
    stateUnwatch();
  }, 30000);
});

void client.connect();
