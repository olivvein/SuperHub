import { randomUUID } from "node:crypto";
import { HubClient } from "@superhub/sdk";

const client = new HubClient({
  httpUrl: "http://127.0.0.1:7777",
  token: process.env.HUB_TOKEN,
  clientId: process.env.CLIENT_ID || randomUUID(),
  serviceName: "music-controller",
  provides: [],
  consumes: ["music.*"],
  debug: true
});

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
