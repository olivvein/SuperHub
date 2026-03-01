import { useEffect, useMemo, useRef, useState } from "react";
import { HubClient } from "@superhub/sdk";

export type HubEventRow = {
  name: string;
  payload: unknown;
  at: number;
};

export function useSuperHub(options?: {
  namePrefix?: string;
  serviceName?: string;
}) {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<HubEventRow[]>([]);
  const clientRef = useRef<HubClient | null>(null);

  const httpUrl = useMemo(
    () => (import.meta.env.VITE_HUB_HTTP_URL || "https://macbook-pro-de-olivier.local").replace(/\/$/, ""),
    []
  );
  const token = useMemo(() => import.meta.env.VITE_HUB_TOKEN || "", []);
  const clientId = useMemo(() => `react-${crypto.randomUUID()}`, []);
  const namePrefix = options?.namePrefix ?? "iss.";
  const serviceName = options?.serviceName ?? "react-monitor";

  useEffect(() => {
    const client = new HubClient({
      httpUrl,
      token,
      clientId,
      serviceName,
      consumes: [namePrefix + "*"],
      debug: true
    });

    clientRef.current = client;
    const unOpen = client.onOpen(() => setConnected(true));
    const unClose = client.onClose(() => setConnected(false));
    const unError = client.onError((error) => {
      console.error("hub error", error);
    });

    let unSub: (() => void) | null = null;
    void client.connect().then(() => {
      unSub = client.subscribe({ namePrefix }, (message) => {
        setEvents((prev) =>
          [{ name: message.name, payload: message.payload, at: Date.now() }, ...prev].slice(0, 200)
        );
      });
    });

    return () => {
      if (unSub) {
        unSub();
      }
      unError();
      unClose();
      unOpen();
      client.disconnect();
      clientRef.current = null;
    };
  }, [httpUrl, token, clientId, namePrefix, serviceName]);

  return {
    connected,
    events,
    client: clientRef.current
  };
}
