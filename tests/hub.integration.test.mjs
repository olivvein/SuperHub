import assert from "node:assert/strict";
import test from "node:test";
import { closeSocket, collectMessages, connectWsClient, delay, sendEnvelope, startHubTestServer, waitForMessage } from "./helpers/hub-test-utils.mjs";

test("hub routes pub/sub events between clients", async (t) => {
  const hub = await startHubForTest(t);
  if (!hub) {
    return;
  }
  t.after(async () => {
    await hub.stop();
  });

  const subscriber = await connectWsClient({ wsUrl: hub.wsUrl, clientId: "sub-client" });
  const publisher = await connectWsClient({ wsUrl: hub.wsUrl, clientId: "pub-client" });

  t.after(async () => {
    await closeSocket(subscriber);
    await closeSocket(publisher);
  });

  sendEnvelope(subscriber, {
    type: "cmd",
    name: "subscribe",
    source: { clientId: "sub-client" },
    target: { serviceName: "hub" },
    schemaVersion: 1,
    payload: {
      subscriptionId: "sub-1",
      namePrefix: "music."
    }
  });
  await delay(50);

  sendEnvelope(publisher, {
    type: "event",
    name: "music.played",
    source: { clientId: "pub-client" },
    target: "*",
    schemaVersion: 1,
    payload: { trackId: "track-1" }
  });

  const message = await waitForMessage(subscriber, (candidate) => candidate.type === "event" && candidate.name === "music.played");
  assert.equal(message.payload.trackId, "track-1");
});

test("hub emits rpc timeout when provider does not answer", async (t) => {
  const hub = await startHubForTest(t);
  if (!hub) {
    return;
  }
  t.after(async () => {
    await hub.stop();
  });

  const requester = await connectWsClient({ wsUrl: hub.wsUrl, clientId: "rpc-requester" });
  const provider = await connectWsClient({ wsUrl: hub.wsUrl, clientId: "rpc-provider", serviceName: "music" });
  await delay(60);

  t.after(async () => {
    await closeSocket(requester);
    await closeSocket(provider);
  });

  const providerInboundPromise = waitForMessage(
    provider,
    (candidate) => candidate.type === "rpc_req" && candidate.correlationId === "corr-timeout",
    3000
  );
  const timeoutResponsePromise = waitForMessage(
    requester,
    (candidate) => candidate.type === "rpc_res" && candidate.correlationId === "corr-timeout",
    6000
  );

  sendEnvelope(requester, {
    type: "rpc_req",
    name: "music.play",
    source: { clientId: "rpc-requester" },
    target: { serviceName: "music" },
    correlationId: "corr-timeout",
    schemaVersion: 1,
    payload: {
      method: "music.play",
      args: { trackId: "track-timeout" },
      timeoutMs: 200
    }
  });

  await providerInboundPromise;
  const timeoutResponse = await timeoutResponsePromise;

  assert.equal(timeoutResponse.payload.ok, false);
  assert.equal(timeoutResponse.payload.error.code, "RPC_TIMEOUT");
});

test("hub propagates state watch updates", async (t) => {
  const hub = await startHubForTest(t);
  if (!hub) {
    return;
  }
  t.after(async () => {
    await hub.stop();
  });

  const watcher = await connectWsClient({ wsUrl: hub.wsUrl, clientId: "watcher" });
  const setter = await connectWsClient({ wsUrl: hub.wsUrl, clientId: "setter" });

  t.after(async () => {
    await closeSocket(watcher);
    await closeSocket(setter);
  });

  sendEnvelope(watcher, {
    type: "cmd",
    name: "state_watch",
    source: { clientId: "watcher" },
    target: { serviceName: "hub" },
    schemaVersion: 1,
    payload: {
      watchId: "watch-1",
      prefix: "state/music"
    }
  });
  await delay(50);

  sendEnvelope(setter, {
    type: "cmd",
    name: "state_set",
    source: { clientId: "setter" },
    target: { serviceName: "hub" },
    schemaVersion: 1,
    payload: {
      path: "state/music/current",
      value: { trackId: "track-watch" }
    }
  });

  const patch = await waitForMessage(
    watcher,
    (candidate) => candidate.type === "state_patch" && candidate.payload?.path === "state/music/current",
    2500
  );

  assert.equal(patch.payload.value.trackId, "track-watch");
});

test("hub handles high-frequency state watch updates", async (t) => {
  const hub = await startHubForTest(t);
  if (!hub) {
    return;
  }
  t.after(async () => {
    await hub.stop();
  });

  const watcher = await connectWsClient({ wsUrl: hub.wsUrl, clientId: "watcher-fast" });
  const setter = await connectWsClient({ wsUrl: hub.wsUrl, clientId: "setter-fast" });

  t.after(async () => {
    await closeSocket(watcher);
    await closeSocket(setter);
  });

  sendEnvelope(watcher, {
    type: "cmd",
    name: "state_watch",
    source: { clientId: "watcher-fast" },
    target: { serviceName: "hub" },
    schemaVersion: 1,
    payload: {
      watchId: "watch-fast",
      prefix: "state/iss"
    }
  });
  await delay(30);

  const burstCount = 100;
  const collectedPromise = collectMessages(
    watcher,
    (candidate) => candidate.type === "state_patch" && candidate.payload?.path === "state/iss/position",
    burstCount,
    3000
  );

  for (let seq = 0; seq < burstCount; seq += 1) {
    sendEnvelope(setter, {
      type: "cmd",
      name: "state_set",
      source: { clientId: "setter-fast" },
      target: { serviceName: "hub" },
      schemaVersion: 1,
      payload: {
        path: "state/iss/position",
        value: { seq }
      }
    });
  }

  const messages = await collectedPromise;
  assert.equal(messages.length, burstCount);
  assert.equal(messages[messages.length - 1].payload.value.seq, burstCount - 1);
});

test("hub increments reconnect metric for same clientId", async (t) => {
  const hub = await startHubForTest(t);
  if (!hub) {
    return;
  }
  t.after(async () => {
    await hub.stop();
  });

  const first = await connectWsClient({ wsUrl: hub.wsUrl, clientId: "reconnect-client" });
  await closeSocket(first);

  const second = await connectWsClient({ wsUrl: hub.wsUrl, clientId: "reconnect-client" });
  t.after(async () => {
    await closeSocket(second);
  });

  await new Promise((resolve) => setTimeout(resolve, 100));

  const metricsResponse = await hub.runtime.app.inject({
    method: "GET",
    url: "/api/metrics",
    headers: {
      "x-hub-token": "test-token"
    }
  });

  assert.equal(metricsResponse.statusCode, 200);
  const metrics = metricsResponse.json();
  assert.ok(metrics.reconnectCount >= 1);
});

test("diagnostics endpoint returns routing state", async (t) => {
  const hub = await startHubForTest(t);
  if (!hub) {
    return;
  }
  t.after(async () => {
    await hub.stop();
  });

  const response = await hub.runtime.app.inject({
    method: "GET",
    url: "/api/diagnostics",
    headers: {
      "x-hub-token": "test-token"
    }
  });

  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.ok(typeof payload.routing.pendingWsRpc === "number");
  assert.ok(typeof payload.sessions.total === "number");
  assert.ok(payload.config.security.tokenConfigured === true);
});

async function startHubForTest(t) {
  try {
    return await startHubTestServer();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
      t.skip("Skipping integration test: sandbox does not allow listening on localhost");
      return null;
    }
    throw error;
  }
}
