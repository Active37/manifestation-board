import assert from "node:assert/strict";
import test from "node:test";
import { hashIdentifier } from "./identifiers.js";

test("hashes identifiers with a keyed, type-specific HMAC", () => {
  const secret = "a-random-secret-with-at-least-32-characters";
  const deviceHash = hashIdentifier(secret, "device", "device-token");

  assert.match(deviceHash, /^[a-f0-9]{64}$/);
  assert.notEqual(deviceHash, "device-token");
  assert.notEqual(
    deviceHash,
    hashIdentifier(secret, "ip", "device-token"),
  );
  assert.notEqual(
    deviceHash,
    hashIdentifier("another-secret-with-at-least-32-characters", "device", "device-token"),
  );
});
