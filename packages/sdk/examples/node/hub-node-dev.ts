import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HubClient, type HubClientOptions } from "@superhub/sdk";

export function createNodeDevClient(options: Omit<HubClientOptions, "httpUrl" | "token" | "clientId" | "tls">): HubClient {
  const httpUrl = (process.env.HUB_HTTP_URL || "https://macbook-pro-de-olivier.local").replace(/\/$/, "");
  const useTls = httpUrl.startsWith("https://");
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

  if (useTls && !tlsCaFile && !tlsInsecure) {
    console.warn(
      "TLS verify is enabled without HUB_TLS_CA_FILE. If Caddy local CA is not trusted by Node, set HUB_TLS_CA_FILE."
    );
  }

  if (useTls && tlsCaFile) {
    console.log(`Using TLS CA file: ${tlsCaFile}`);
  }

  return new HubClient({
    ...options,
    httpUrl,
    token: process.env.HUB_TOKEN,
    clientId: process.env.CLIENT_ID || randomUUID(),
    tls: useTls
      ? {
          caFile: tlsCaFile,
          rejectUnauthorized: !tlsInsecure
        }
      : undefined
  });
}
