import { useMemo } from "react";
import { useSuperHub } from "./useSuperHub";

type IssPosition = {
  lat: number;
  lon: number;
  altKm: number;
  at: number;
};

export function IssPanel() {
  const { connected, events } = useSuperHub({ namePrefix: "iss.", serviceName: "react-iss-panel" });

  const lastPosition = useMemo<IssPosition | null>(() => {
    const row = events.find((event) => event.name === "iss.position");
    if (!row || !row.payload || typeof row.payload !== "object") {
      return null;
    }
    const payload = row.payload as Partial<IssPosition>;
    if (
      typeof payload.lat !== "number" ||
      typeof payload.lon !== "number" ||
      typeof payload.altKm !== "number" ||
      typeof payload.at !== "number"
    ) {
      return null;
    }
    return payload as IssPosition;
  }, [events]);

  return (
    <section style={{ fontFamily: "ui-sans-serif, system-ui", maxWidth: 780, margin: "24px auto", padding: 16 }}>
      <h2 style={{ marginBottom: 8 }}>ISS Realtime Panel</h2>
      <p style={{ marginTop: 0 }}>Status: {connected ? "connected" : "disconnected"}</p>

      {lastPosition ? (
        <pre style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 12 }}>
          {JSON.stringify(
            {
              lat: Number(lastPosition.lat.toFixed(4)),
              lon: Number(lastPosition.lon.toFixed(4)),
              altKm: Number(lastPosition.altKm.toFixed(2)),
              at: new Date(lastPosition.at).toISOString()
            },
            null,
            2
          )}
        </pre>
      ) : (
        <p>No `iss.position` event yet.</p>
      )}

      <h3>Recent events</h3>
      <ul style={{ maxHeight: 280, overflow: "auto", paddingLeft: 18 }}>
        {events.slice(0, 20).map((event, index) => (
          <li key={`${event.at}-${index}`}>
            <code>{event.name}</code> @ {new Date(event.at).toLocaleTimeString()}
          </li>
        ))}
      </ul>
    </section>
  );
}
