import assert from "node:assert/strict";
import test from "node:test";
import { ContractRegistry, createDefaultContractRegistry, HubEnvelopeSchema } from "../packages/contracts/dist/index.js";

test("contracts registry validates by name and schemaVersion", () => {
  const registry = createDefaultContractRegistry();

  const valid = registry.validate("music.play", 1, { trackId: "abc", positionMs: 10 });
  assert.equal(valid.ok, true);

  const invalid = registry.validate("music.play", 1, { trackId: 42 });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues && invalid.issues.length > 0);

  const unknown = registry.validate("something.else", 1, { any: "value" });
  assert.equal(unknown.ok, true);
});

test("contract registry supports custom schemas", () => {
  const registry = new ContractRegistry();
  registry.register("custom.event", 2, HubEnvelopeSchema.shape.payload);

  const result = registry.validate("custom.event", 2, { x: 1 });
  assert.equal(result.ok, true);
});
