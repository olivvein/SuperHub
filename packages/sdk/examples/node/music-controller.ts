import { createNodeDevClient } from "./hub-node-dev";

const client = createNodeDevClient({
  serviceName: "music-controller",
  provides: [],
  consumes: ["music.*"],
  tags: ["example", "sdk", "controller"],
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

client.onError((error) => {
  console.error("music-controller error", error);
});

void client.connect();
