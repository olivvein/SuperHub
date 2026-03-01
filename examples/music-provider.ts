import { randomUUID } from "node:crypto";
import { HubClient } from "@superhub/sdk";

const client = new HubClient({
  httpUrl: "http://127.0.0.1:7777",
  token: process.env.HUB_TOKEN,
  clientId: process.env.CLIENT_ID || randomUUID(),
  serviceName: "music",
  version: "0.1.0",
  provides: ["music.play", "music.pause", "music.next"],
  consumes: ["music.*"],
  tags: ["example", "provider"],
  debug: true
});

client.onOpen(() => {
  console.log("music-provider connected");

  client.subscribe({ names: ["music.play"] }, async (message) => {
    console.log("music.play command received", message.payload);

    if (!message.correlationId) {
      return;
    }

    client.publish("music.played", { ok: true, at: Date.now() }, message.source.clientId ? { clientId: message.source.clientId } : "*");
  });
});

client.onError((error) => {
  console.error("music-provider error", error);
});

client.onClose(() => {
  console.log("music-provider disconnected");
});

void client.connect();
