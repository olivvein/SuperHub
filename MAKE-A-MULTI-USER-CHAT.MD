# Make A Multi User Chat With SuperHub (Node.js/TS + React)

This guide explains how to build a production-style multi-user chat networking layer with SuperHub.
Scope is networking only: transport, message model, presence, delivery, scaling strategy.

## 1. Architecture

Use three layers:

1. Hub transport (already provided by SuperHub)
- HTTPS API + WSS stream
- pub/sub, rpc, state, metrics, diagnostics

2. Chat service provider (Node.js/TypeScript)
- service name: `chat-core`
- validates messages and room rules
- emits canonical chat events

3. Chat clients (React web)
- join rooms
- subscribe to room streams
- send messages via RPC (for reliability and server validation)

## 2. Channel Design

Use explicit event names:

- `chat.room.joined`
- `chat.room.left`
- `chat.message.created`
- `chat.message.edited` (optional)
- `chat.message.deleted` (optional)
- `chat.typing` (ephemeral)
- `chat.presence` (ephemeral)

Use room-prefixed topics in payload:
- `roomId`
- `userId`

## 3. Reliable vs Ephemeral Traffic

Reliable path (must be acknowledged):
- send message
- edit/delete message
- moderation actions

Use RPC for these:
- `chat.sendMessage`
- `chat.editMessage`
- `chat.deleteMessage`

Ephemeral path (loss-tolerant):
- typing indicator
- cursor/activity presence

Use pub/sub events for these:
- `chat.typing`
- `chat.presence`

## 4. Minimal Contracts

Keep strict Zod schemas in `@superhub/contracts`.

Send message request:

```ts
{
  roomId: string;
  text: string;          // max length enforced server-side
  clientMsgId: string;   // uuid for idempotency
}
```

Send message response:

```ts
{
  messageId: string;
  roomId: string;
  userId: string;
  text: string;
  createdAt: number;
}
```

Broadcast message event:

```ts
{
  messageId: string;
  roomId: string;
  userId: string;
  text: string;
  createdAt: number;
}
```

Typing event (ephemeral):

```ts
{
  roomId: string;
  userId: string;
  isTyping: boolean;
  ts: number;
}
```

## 5. Room State Strategy

Use SuperHub state store for low-frequency state:

- `state/chat/<roomId>/meta`
- `state/chat/<roomId>/members`
- `state/chat/<roomId>/lastMessage`

Do not store every message in state.
For message history, use your own persistence in the chat provider (SQLite/Postgres).

## 6. Delivery and Idempotency

For message creation:

1. Client sends `rpc("chat-core", "chat.sendMessage", payload)`
2. Provider validates, persists, creates `messageId`
3. Provider publishes `chat.message.created`
4. Provider returns RPC response

Use `clientMsgId` to deduplicate retries:
- if same `(userId, roomId, clientMsgId)` appears again, return existing message

## 7. React Client Pattern

Connect once, then:

1. subscribe to room events
2. watch room state
3. send reliable actions by RPC
4. throttle typing updates

Example hook:

```ts
import { useEffect, useRef } from 'react';
import { HubClient } from '@superhub/sdk';

export function useChat(roomId: string) {
  const hubRef = useRef<HubClient | null>(null);

  useEffect(() => {
    const hub = new HubClient({
      httpUrl: import.meta.env.VITE_HUB_HTTP_URL,
      token: import.meta.env.VITE_HUB_TOKEN,
      clientId: `chat-${crypto.randomUUID()}`,
      consumes: ['chat.*'],
    });
    hubRef.current = hub;

    (async () => {
      await hub.connect();
      await hub.subscribe({ names: ['chat.message.created', 'chat.typing', 'chat.presence'] }, (msg) => {
        if (msg.payload?.roomId !== roomId) return;
        // update local store
      });
    })().catch(console.error);

    return () => {
      hub.disconnect().catch(() => {});
    };
  }, [roomId]);

  async function sendMessage(text: string) {
    const hub = hubRef.current;
    if (!hub) return;
    await hub.rpc('chat-core', 'chat.sendMessage', {
      roomId,
      text,
      clientMsgId: crypto.randomUUID(),
    });
  }

  return { sendMessage };
}
```

## 8. Node.js/TS Provider Pattern

Provider responsibilities:
- authenticate/authorize room access
- validate payloads
- rate limit abusive users
- persist and fanout events

Minimal skeleton:

```ts
import { HubClient } from '@superhub/sdk';

const hub = new HubClient({
  httpUrl: process.env.HUB_HTTP_URL!,
  token: process.env.HUB_TOKEN,
  clientId: `chat-core-${crypto.randomUUID()}`,
  serviceName: 'chat-core',
  provides: ['chat.*'],
});

await hub.connect();

hub.onRpc('chat.sendMessage', async (payload, ctx) => {
  // validate + auth + persistence
  const created = {
    messageId: crypto.randomUUID(),
    roomId: payload.roomId,
    userId: ctx.source.clientId,
    text: payload.text,
    createdAt: Date.now(),
  };

  await hub.publish('chat.message.created', created);
  return created;
});
```

## 9. Performance Tuning

1. Message size limits
- keep max chat text and metadata bounded

2. Typing throttle
- send every 300 to 1000 ms max, not on each keypress

3. Presence cadence
- heartbeat every 10 to 30 s

4. Backpressure policy
- ephemeral events can be dropped under pressure
- reliable RPC should reject with explicit error on overload

5. Room fanout
- for very large rooms, shard by room service (`chat-room-<id>`) instead of one global provider

## 10. Moderation and Safety Hooks

Add server-side hooks before publish:
- max length + forbidden content
- room membership check
- mute/ban list check
- cooldown per user (anti-spam)

Never trust client moderation.

## 11. Observability

Use SuperHub console to track:
- clients online
- msg/sec and bytes/sec
- dropped messages
- rpc p95 latency
- queue depth

Add chat metrics in provider logs:
- messages per room/min
- rejects per reason
- typing events rate

## 12. Failure Modes

1. Duplicate messages
- fix with `clientMsgId` idempotency keys

2. Late UI updates
- ensure you update on `chat.message.created` event, not only RPC response

3. Flood during peak
- throttle typing/presence
- enforce per-user rate limits
- mute noisy topics temporarily using SuperHub control tab

## 13. Suggested Baseline

- room size: start 50 users/room
- typing throttle: 500 ms
- presence update: 15 s
- max message length: 1k chars
- rpc timeout: 3 s

Then tune with real metrics.

## 14. Summary

For a robust multi-user chat on SuperHub:
- use RPC for reliable writes
- use pub/sub for realtime fanout
- use state store for low-frequency room state
- keep ephemeral traffic throttled
- enforce server-side validation and idempotency
- watch metrics continuously
