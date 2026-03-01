import { createNodeDevClient } from "./hub-node-dev";

type IssPosition = {
  lat: number;
  lon: number;
  altKm: number;
  at: number;
};

const client = createNodeDevClient({
  serviceName: "iss-monitor",
  version: "0.1.0",
  provides: [],
  consumes: ["iss.*"],
  tags: ["example", "sdk", "monitor"],
  debug: true
});

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
