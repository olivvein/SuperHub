import assert from "node:assert/strict";
import test from "node:test";
import { isIpAllowlisted, normalizeClientIp } from "../packages/hub/dist/network.js";

test("normalizeClientIp handles proxy/port forms", () => {
  assert.equal(normalizeClientIp("127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeClientIp("127.0.0.1:8080"), "127.0.0.1");
  assert.equal(normalizeClientIp("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeClientIp("127.0.0.1, 10.0.0.2"), "127.0.0.1");
});

test("allowlist matches cidr and wildcard", () => {
  assert.equal(isIpAllowlisted("127.0.0.1", ["127.0.0.1/32"]), true);
  assert.equal(isIpAllowlisted("10.10.0.5", ["10.0.0.0/8"]), true);
  assert.equal(isIpAllowlisted("10.10.0.5", ["192.168.0.0/16"]), false);
  assert.equal(isIpAllowlisted("203.0.113.1", ["*"]), true);
});
