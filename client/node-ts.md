# Node.js + TypeScript Client Guide

This guide is for Node services/scripts using `@superhub/sdk`.

## 1) Prerequisites

- Hub running (`npm run dev`)
- Caddy running for HTTPS/WSS
- token available (`HUB_TOKEN`)

## 2) Install and Run

Install from LAN artifact (no npm publish):

```bash
npm install "https://mac-mini-de-olivier.local/apps/client/dist/npm/superhub-sdk-latest.tgz"
```

Scaffold bundled examples into your project:

```bash
npx --no-install superhub-examples ./superhub-examples
```

Or install directly from a local SuperHub clone:

```bash
npm install /path/to/SuperHub/packages/sdk
```

In this monorepo, the SDK is already available through workspaces.

Run scripts with:

```bash
HUB_TOKEN=CHANGE_ME_SUPERHUB_TOKEN npx tsx your-script.ts
```

## 3) Minimal Client

```ts
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HubClient } from "@superhub/sdk";

const httpUrl = (process.env.HUB_HTTP_URL || "https://mac-mini-de-olivier.local").replace(/\/$/, "");
const useTls = httpUrl.startsWith("https://");
const tlsInsecure = ["1", "true", "yes", "on"].includes((process.env.HUB_TLS_INSECURE || "").toLowerCase());
const defaultCaddyCa = path.join(homedir(), "Library", "Application Support", "Caddy", "pki", "authorities", "local", "root.crt");
const tlsCaFile = process.env.HUB_TLS_CA_FILE || (existsSync(defaultCaddyCa) ? defaultCaddyCa : undefined);

const client = new HubClient({
  httpUrl,
  token: process.env.HUB_TOKEN,
  tls: useTls
    ? {
        caFile: tlsCaFile,
        rejectUnauthorized: !tlsInsecure
      }
    : undefined,
  clientId: process.env.CLIENT_ID || randomUUID(),
  serviceName: "demo-node-client",
  provides: [],
  consumes: ["music.*"],
  debug: true
});

client.onOpen(async () => {
  console.log("connected");

  const unsubscribe = client.subscribe({ namePrefix: "music." }, (msg) => {
    console.log("event", msg.name, msg.payload);
  });

  const stateUnwatch = client.watchState("state/music", (path, value) => {
    console.log("state patch", path, value);
  });

  const response = await client.rpc("music", "music.play", { trackId: "track-1", positionMs: 0 }, 5000);
  console.log("rpc response", response);

  client.publish("demo.ping", { at: Date.now() }, "*");
  client.setState("state/demo/lastPing", { at: Date.now() });

  setTimeout(() => {
    unsubscribe();
    stateUnwatch();
    client.disconnect();
  }, 15000);
});

client.onError((err) => console.error("hub error", err));
client.onClose(() => console.log("disconnected"));

void client.connect();
```

## 4) Provider Handler (RPC server side)

```ts
client.onRpc("music.play", async (args) => {
  const input = (args || {}) as { trackId?: string; positionMs?: number };
  return {
    accepted: true,
    trackId: input.trackId ?? "unknown-track",
    positionMs: input.positionMs ?? 0
  };
});
```

## 5) Useful Env Vars

- `HUB_HTTP_URL` default: `https://mac-mini-de-olivier.local`
- `HUB_TOKEN` shared token
- `CLIENT_ID` optional stable id
- `HUB_TLS_CA_FILE` custom CA path
- `HUB_TLS_INSECURE=1` disable TLS verification for local debug only

## 6) Troubleshooting

- `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`:
  - set `HUB_TLS_CA_FILE` to Caddy `root.crt`.
  - for install step:
  - `curl -k "https://mac-mini-de-olivier.local/apps/client/dist/certs/caddy-local-root.crt" -o "$HOME/.superhub-caddy-root.crt"`
  - `npm_config_cafile="$HOME/.superhub-caddy-root.crt" npm install "https://mac-mini-de-olivier.local/apps/client/dist/npm/superhub-sdk-latest.tgz"`
- `FORBIDDEN`:
  - check `security.allowlistSubnets` and token.
- no messages:
  - verify same hub URL and token on all clients.
