import assert from "node:assert/strict";
import test from "node:test";
import {
  startRejectedPostCleanup,
  startSecurityDataCleanup,
} from "./cleanup.js";

test("runs rejected-post cleanup on startup and stops its timer", async () => {
  let calls = 0;
  const stop = startRejectedPostCleanup(async () => {
    calls += 1;
    return 0;
  }, 60_000);

  await new Promise<void>((resolve) => setImmediate(resolve));
  stop();

  assert.equal(calls, 1);
});

test("runs security-data cleanup on startup without exposing details", async () => {
  let calls = 0;
  const stop = startSecurityDataCleanup(async () => {
    calls += 1;
    return 2;
  }, 60_000);

  await new Promise<void>((resolve) => setImmediate(resolve));
  stop();

  assert.equal(calls, 1);
});
