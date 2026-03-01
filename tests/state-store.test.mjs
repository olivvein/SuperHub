import assert from "node:assert/strict";
import test from "node:test";
import { StateStore } from "../packages/hub/dist/state-store.js";

test("state store set/get/list", () => {
  const store = new StateStore();

  store.set("music/current", { trackId: "t1" });

  assert.deepEqual(store.get("state/music/current"), { trackId: "t1" });
  assert.deepEqual(store.get("state/music/missing"), null);

  const entries = store.list("state/music");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, "state/music/current");
});

test("state store patch", () => {
  const store = new StateStore();
  store.set("state/music/current", { trackId: "t1", volume: 10 });

  store.patch("state/music/current", [{ op: "replace", path: "/volume", value: 20 }]);

  assert.deepEqual(store.get("state/music/current"), { trackId: "t1", volume: 20 });
});
