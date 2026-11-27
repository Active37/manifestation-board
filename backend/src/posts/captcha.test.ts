import assert from "node:assert/strict";
import test from "node:test";
import { verifyTurnstile } from "./captcha.js";

async function withTurnstileResponse<T>(
  payload: unknown,
  action: () => Promise<T>,
  status = 200,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("accepts a fresh successful token for the expected hostname and action", async () => {
  const result = await withTurnstileResponse(
    {
      success: true,
      challenge_ts: new Date().toISOString(),
      hostname: "board.example.org",
      action: "create_goal",
    },
    () => verifyTurnstile("valid-token", "secret", {
      hostname: "board.example.org",
      action: "create_goal",
    }),
  );
  assert.equal(result, true);
});

test("rejects unsuccessful, stale, future, wrong-host, or wrong-action responses", async () => {
  const expected = { hostname: "board.example.org", action: "create_goal" };
  const base = {
    success: true,
    challenge_ts: new Date().toISOString(),
    hostname: "board.example.org",
    action: "create_goal",
  };
  const cases: unknown[] = [
    { ...base, success: false },
    { ...base, challenge_ts: new Date(Date.now() - 6 * 60_000).toISOString() },
    { ...base, challenge_ts: new Date(Date.now() + 60_000).toISOString() },
    { ...base, hostname: "other.example.org" },
    { ...base, action: "login" },
  ];
  for (const payload of cases) {
    const result = await withTurnstileResponse(
      payload,
      () => verifyTurnstile("test-token", "secret", expected),
    );
    assert.equal(result, false);
  }
});

test("reports provider failures as service unavailable", async () => {
  await assert.rejects(
    withTurnstileResponse(
      { success: false },
      () => verifyTurnstile("test-token", "secret"),
      503,
    ),
    { statusCode: 503 },
  );
});