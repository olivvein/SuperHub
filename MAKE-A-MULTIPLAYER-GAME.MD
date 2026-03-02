# Make A Multiplayer Game With SuperHub (Networking Layer)

This guide explains how to build a high-performance networking layer for a small FPS on top of SuperHub.
Target stack: Node.js + TypeScript for authoritative services, React for web clients.
It only covers networking and synchronization, not rendering or gameplay content.

## 1. Scope and Constraints

- Target: small FPS (LAN or low-latency private network), typically 2 to 16 players.
- Transport: WebSocket over TLS through SuperHub (`wss://.../ws`).
- Model: server authoritative simulation.
- Performance goal:
  - server sim tick: 60 Hz
  - input send: 30 to 60 Hz
  - snapshot send: 15 to 30 Hz
  - end-to-end feel: responsive with client prediction + interpolation

Important constraint:
- SuperHub uses WS/TCP, so messages are reliable and ordered at transport level.
- For FPS feel, design app-level "soft-unreliable" streams by replacing old state with newest state and using sequence numbers.

## 2. High-Level Architecture

Use three logical roles:

1. Match service (optional)
- Creates rooms and returns `roomId`.

2. Game room authority (required)
- One authoritative simulation per room.
- Runs as SuperHub service provider, for example `serviceName = game-room-<roomId>`.

3. Player clients
- Send input commands.
- Predict locally.
- Reconcile from authoritative snapshots.

Recommended deployment:
- Keep room simulation in Node/TS service providers connected to the same SuperHub.
- SuperHub handles routing, subscriptions, auth token, observability, control plane.

## 3. Network Channels (By Intent)

Split traffic into intent-based channels:

1. Input stream (high frequency, latest wins)
- Name: `game.input`
- Client -> room authority
- Payload contains sequence and compact input bits.

2. Snapshot stream (high frequency, latest wins)
- Name: `game.snapshot`
- Room authority -> clients
- Full or delta state for visible entities.

3. Reliable game actions (must not be dropped)
- Name: `game.action` or RPC methods
- Weapon switch, round start, buy, respawn request, admin commands.

4. Control and lifecycle (reliable)
- RPC: `game.join`, `game.leave`, `game.spawn`, `game.respawn`.

5. Low-frequency shared state
- SuperHub state store for room metadata, scoreboard, match timer.
- Do not use state store for per-frame transforms.

## 4. Message Contracts (Compact)

Use strict contracts (`@superhub/contracts` + Zod). Keep payloads small.

### 4.1 Input message (client -> server)

```ts
// name: game.input
// type: event
{
  roomId: string,
  playerId: string,
  inputSeq: number,      // increments per input packet
  clientTick: number,
  dtMs: number,
  moveX: number,         // quantized int16 or small int
  moveY: number,
  yaw: number,           // quantized (0..65535)
  pitch: number,
  buttons: number,       // bitmask: jump/fire/reload/crouch/etc
  weaponSlot: number
}
```

### 4.2 Snapshot message (server -> clients)

```ts
// name: game.snapshot
// type: event
{
  roomId: string,
  serverTick: number,
  baselineTick?: number, // if delta snapshot
  ackInputSeqByPlayer: Record<string, number>,
  entities: Array<{
    id: string,
    kind: number,        // player/projectile/etc as enum int
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    yaw: number, pitch: number,
    hp?: number,
    flags: number
  }>,
  events?: Array<{
    id: string,
    t: number,
    k: number,           // event kind enum
    a?: number,
    b?: number
  }>
}
```

### 4.3 Reliable RPC examples

- `game.join({ roomId, nickname, loadout }) -> { playerId, spawn, serverTick }`
- `game.fire({ shotId, clientTick, origin, dir, weapon }) -> { accepted, serverTick }`

## 5. Authoritative Tick Model

Server loop (room authority):

1. Run simulation at fixed 60 Hz.
2. At each tick:
- consume newest input per player (or small buffered window)
- simulate movement, physics, projectiles, rules
- resolve hits authoritatively
3. Every N ticks (for example 3): send snapshot at 20 Hz.
4. Include `ackInputSeqByPlayer` in snapshots to support reconciliation.

Guideline:
- Never trust client position or hit result.
- Client sends intent; server decides truth.

## 6. Client Netcode Model

Each client uses four loops:

1. Input capture loop (frame rate)
- read controls and build command.

2. Input send loop (30 to 60 Hz)
- send newest input with incrementing `inputSeq`.

3. Prediction loop (local)
- immediately apply local input to local predicted player.
- store history by `inputSeq`.

4. Snapshot apply loop (on receive)
- for local player:
  - snap to authoritative state at acknowledged input
  - replay unacked inputs from history (reconciliation)
- for remote players:
  - place snapshots in interpolation buffer
  - render at `now - interpolationDelay` (for example 100 ms)

## 7. Reconciliation and Interpolation

Local player:
- Keep circular buffer of `{inputSeq, stateBefore, stateAfter}`.
- On snapshot with `ackInputSeq`:
  - set player state to authoritative state
  - replay pending inputs after ack

Remote players:
- Keep 2+ snapshots in buffer.
- Interpolate transforms between snapshot A and B.
- If B missing briefly, extrapolate for max 100 ms, then hold.

## 8. Lag Compensation (Hitscan)

For fair shooting:

1. Server stores short history of hitbox states by tick/time (for example last 200 ms).
2. Client sends shot with `clientTick` and ray.
3. Server maps to estimated server time, rewinds hitboxes to that time.
4. Server validates raycast in rewound world.
5. Server applies damage in current authoritative timeline.

Do not accept direct client "I hit player X" claims.

## 9. Interest Management

Do not broadcast every entity to everyone.

Use spatial filtering:
- divide map into cells or zones
- send each player only nearby/relevant entities
- include always-visible entities (objective, own projectiles, etc)

This is the biggest bandwidth saver for FPS scalability.

## 10. Backpressure and Throughput Strategy

SuperHub already has queue limits and drop policies. Design game traffic around it:

1. High-frequency streams (`game.input`, `game.snapshot`)
- latest wins
- if queue pressure increases, drop stale updates and keep newest

2. Reliable commands (`game.join`, `game.fire` confirmation, round events)
- use RPC or critical event paths
- must return explicit error on overload rather than silent loss

3. Keep payload small
- quantize floats
- use numeric enums instead of long strings
- avoid large nested objects in per-tick messages

4. Batch when useful
- combine several entity updates in one snapshot packet

## 11. SuperHub-Specific Practical Rules

1. Use `serviceName` per room authority
- Example: `game-room-42`

2. Use topic naming conventions
- `game.<roomId>.input`
- `game.<roomId>.snapshot`
- `game.<roomId>.event`

3. Keep state store for low-frequency data
- `state/game/<roomId>/scoreboard`
- `state/game/<roomId>/phase`

4. Use dashboard and diagnostics continuously
- monitor msg/sec, bytes/sec, queue size, dropped messages, rpc p95

5. Use control plane when testing overload
- pause inbound, mute noisy topics, clear queues, disconnect bad session

## 12. Suggested Tick/Bandwidth Baseline

Start with:

- server simulation: 60 Hz
- input packets: 30 Hz
- snapshots: 20 Hz
- interpolation delay: 100 ms
- snapshot target size: 1 to 6 KB (depending on entity count)
- max players per room: start at 8, then profile

Then tune based on real metrics from SuperHub console.

## 13. Node.js/TS + React Skeleton (Networking Only)

### 13.1 Room authority (provider)

```ts
import { HubClient } from '@superhub/sdk';

const roomId = 'room-1';
const serviceName = `game-room-${roomId}`;

const hub = new HubClient({
  httpUrl: process.env.HUB_HTTP_URL!,
  token: process.env.HUB_TOKEN,
  clientId: `room-server-${roomId}`,
  serviceName,
  provides: ['game.*'],
});

await hub.connect();

const latestInputs = new Map<string, any>();

await hub.subscribe({ namePrefix: `game.${roomId}.input` }, (msg) => {
  latestInputs.set(msg.payload.playerId, msg.payload);
});

setInterval(async () => {
  // 60 Hz simulation step
  // consume latestInputs, simulate authoritative world
}, 1000 / 60);

setInterval(async () => {
  // 20 Hz snapshot broadcast
  await hub.publish(`game.${roomId}.snapshot`, {
    roomId,
    serverTick: Date.now(),
    ackInputSeqByPlayer: {},
    entities: []
  });
}, 1000 / 20);
```

### 13.2 React player client

```ts
import { useEffect, useRef } from 'react';
import { HubClient } from '@superhub/sdk';

export function useGameNet(roomId: string) {
  const hubRef = useRef<HubClient | null>(null);
  const inputSeqRef = useRef(0);

  useEffect(() => {
    let mounted = true;
    const hub = new HubClient({
      httpUrl: import.meta.env.VITE_HUB_HTTP_URL,
      token: import.meta.env.VITE_HUB_TOKEN,
      clientId: `player-${crypto.randomUUID()}`,
      consumes: ['game.*'],
    });
    hubRef.current = hub;

    (async () => {
      await hub.connect();
      await hub.subscribe({ namePrefix: `game.${roomId}.snapshot` }, (msg) => {
        // apply snapshot, reconcile local player, interpolate remotes
      });
    })().catch(console.error);

    const send = setInterval(async () => {
      if (!mounted) return;
      const payload = {
        roomId,
        playerId: hub.clientId,
        inputSeq: ++inputSeqRef.current,
        clientTick: Date.now(),
        dtMs: 16,
        moveX: 0,
        moveY: 1,
        yaw: 123,
        pitch: 456,
        buttons: 0,
        weaponSlot: 1,
      };
      await hub.publish(`game.${roomId}.input`, payload);
    }, 1000 / 30);

    return () => {
      mounted = false;
      clearInterval(send);
      hub.disconnect().catch(() => {});
    };
  }, [roomId]);
}
```

### 13.3 React runtime loop hints

- Keep rendering in `requestAnimationFrame`.
- Keep networking loops (`input send`, `snapshot handling`) decoupled from React re-render cycles.
- Store hot path state in refs or external stores, not in heavy component state trees.
- Push only UI-relevant derived values into React state (hp, ammo, scoreboard).

## 14. Performance Checklist

- Server authoritative simulation only.
- Prediction + reconciliation for local player.
- Interpolation buffer for remote players.
- Interest management enabled.
- Quantized compact payloads.
- Strict per-message schema validation in dev.
- Snapshot/input rates tuned with real metrics.
- Queue/drop behavior tested with synthetic load.

## 15. Common Failure Modes and Fixes

1. "Game feels delayed"
- Add/verify client prediction and reconciliation.
- Reduce input send interval.
- Reduce interpolation delay carefully.

2. "Rubber-banding"
- Check authoritative corrections too large.
- Ensure deterministic-ish movement logic client/server.
- Increase snapshot rate or improve replay buffer.

3. "Bandwidth spikes"
- Add interest management.
- Reduce precision and payload size.
- Lower snapshot frequency before lowering sim tick.

4. "Queue growth / drops"
- Drop stale high-frequency updates first.
- Protect reliable commands with RPC and explicit errors.
- Use SuperHub control tab to isolate noisy session/topic.

## 16. What Not To Do

- Do not stream full world state to every player each tick.
- Do not rely on state store for per-frame transforms.
- Do not trust client hit or position claims.
- Do not mix critical and non-critical traffic in one undifferentiated channel.

## 17. Final Notes

With SuperHub, you can build a very good small FPS networking layer, especially on LAN and controlled environments.
The key is not raw transport alone; it is architecture:
- authoritative server
- compact messages
- prediction/reconciliation
- interpolation
- strong observability and backpressure discipline

If you keep these rules, performance scales much better than naive WS realtime approaches.
