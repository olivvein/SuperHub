# React Client Guide

This guide is for React web apps using SuperHub in the browser.

## 1) Browser Requirements

- App served over HTTPS (recommended via Caddy under same host).
- Caddy local CA trusted by your OS/browser profile.
- Token available in app runtime (header for HTTP, query for WS via SDK).

## 2) Install SDK

Install from LAN artifact (no npm publish):

```bash
npm install "https://macbook-pro-de-olivier.local/apps/client/dist/npm/superhub-sdk-latest.tgz"
```

Copy bundled React examples:

```bash
npx --no-install superhub-examples ./superhub-examples
```

Then use files from:
- `superhub-examples/react/useSuperHub.ts`
- `superhub-examples/react/IssPanel.tsx`

If your React app is in this monorepo, `@superhub/sdk` is already available.

If app is external and you are on the same machine, you can also install from local path:

```bash
npm install /path/to/SuperHub/packages/sdk
```

## 3) Create a Hook

`src/lib/useHub.ts`:

```ts
import { useEffect, useMemo, useRef, useState } from "react";
import { HubClient } from "@superhub/sdk";

export function useHub() {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<Array<{ name: string; payload: unknown }>>([]);
  const clientRef = useRef<HubClient | null>(null);

  const httpUrl = useMemo(
    () => (import.meta.env.VITE_HUB_HTTP_URL || "https://macbook-pro-de-olivier.local").replace(/\/$/, ""),
    []
  );
  const token = import.meta.env.VITE_HUB_TOKEN || "";
  const clientId = useMemo(() => `react-${crypto.randomUUID()}`, []);

  useEffect(() => {
    const client = new HubClient({
      httpUrl,
      token,
      clientId,
      serviceName: "react-client",
      consumes: ["music.*"],
      debug: true
    });
    clientRef.current = client;

    const unOpen = client.onOpen(() => setConnected(true));
    const unClose = client.onClose(() => setConnected(false));
    const unErr = client.onError((e) => console.error("hub error", e));

    let unSub: (() => void) | null = null;
    void client.connect().then(() => {
      unSub = client.subscribe({ namePrefix: "music." }, (msg) => {
        setEvents((prev) => [{ name: msg.name, payload: msg.payload }, ...prev].slice(0, 50));
      });
    });

    return () => {
      if (unSub) unSub();
      unErr();
      unClose();
      unOpen();
      client.disconnect();
      clientRef.current = null;
    };
  }, [httpUrl, token, clientId]);

  async function play() {
    const client = clientRef.current;
    if (!client) return;
    const res = await client.rpc("music", "music.play", { trackId: "react-track-1", positionMs: 0 }, 5000);
    return res;
  }

  return { connected, events, play };
}
```

## 4) Use in a Component

```tsx
import { useHub } from "./lib/useHub";

export default function App() {
  const { connected, events, play } = useHub();

  return (
    <main>
      <h1>SuperHub React Client</h1>
      <p>Status: {connected ? "connected" : "disconnected"}</p>
      <button onClick={() => void play()}>Play</button>
      <ul>
        {events.map((e, i) => (
          <li key={i}>
            <strong>{e.name}</strong>: {JSON.stringify(e.payload)}
          </li>
        ))}
      </ul>
    </main>
  );
}
```

## 5) Env Example (Vite)

`.env.local`:

```bash
VITE_HUB_HTTP_URL=https://macbook-pro-de-olivier.local
VITE_HUB_TOKEN=CHANGE_ME_SUPERHUB_TOKEN
```

## 6) CORS and Hosting Notes

- Best setup: serve React app from the same domain via SuperHub/Caddy (`/apps/*`).
- If hosted on a different origin, add that origin in `HUB_CORS_ORIGINS`.
- Browser cannot use `HUB_TLS_CA_FILE`; trust the CA at OS/browser level.

## 7) Troubleshooting

- WS connect fails in browser:
  - verify URL is `wss://.../ws`, token is set, and CORS origin is allowed.
- `ERR_SSL_PROTOCOL_ERROR`:
  - check Caddy cert issuance and trusted local CA.
- install from `https://...tgz` fails with cert errors:
  - bootstrap cert then install:
  - `curl -k "https://macbook-pro-de-olivier.local/apps/client/dist/certs/caddy-local-root.crt" -o "$HOME/.superhub-caddy-root.crt"`
  - `npm_config_cafile="$HOME/.superhub-caddy-root.crt" npm install "https://macbook-pro-de-olivier.local/apps/client/dist/npm/superhub-sdk-latest.tgz"`
- auth forbidden:
  - verify `VITE_HUB_TOKEN` and hub allowlist config.
