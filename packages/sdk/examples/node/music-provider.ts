import { createNodeDevClient } from "./hub-node-dev";

const client = createNodeDevClient({
  serviceName: "music",
  version: "0.1.0",
  provides: ["music.play", "music.pause", "music.next"],
  consumes: ["music.*"],
  tags: ["example", "sdk", "provider"],
  debug: true
});

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
