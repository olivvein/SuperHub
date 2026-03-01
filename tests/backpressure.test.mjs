import assert from "node:assert/strict";
import test from "node:test";
import { applyBackpressure } from "../packages/hub/dist/backpressure.js";

test("backpressure drops oldest non-critical message", () => {
  const state = {
    queue: [{ id: "a", bytes: 10, critical: false }],
    queueBytes: 10
  };

  const decision = applyBackpressure(state, { id: "b", bytes: 10, critical: false }, { maxMessages: 1, maxBytes: 100 });

  assert.equal(decision.accepted, true);
  assert.equal(decision.dropped.length, 1);
  assert.equal(decision.dropped[0].id, "a");
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].id, "b");
});

test("backpressure rejects critical message when overflow requires drop", () => {
  const state = {
    queue: [{ id: "a", bytes: 10, critical: false }],
    queueBytes: 10
  };

  const decision = applyBackpressure(state, { id: "critical", bytes: 10, critical: true }, { maxMessages: 1, maxBytes: 100 });

  assert.equal(decision.accepted, false);
  assert.equal(decision.rejectedCritical, true);
  assert.equal(decision.dropped.length, 1);
  assert.equal(state.queue.length, 0);
});
