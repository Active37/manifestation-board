import assert from "node:assert/strict";
import test from "node:test";
import { verifyTurnstile } from "./captcha.js";

test("verifies the token server-side without sending the visitor IP", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: URLSearchParams | undefined;

  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(init?.method, "POST");
    if (!(init?.body instanceof URLSearchParams)) {
      throw new Error("Expected form-encoded CAPTCHA request");
    }
    requestBody = init.body;
    return new Response(
      JSON.stringify({
        success: true,
        challenge_ts: new Date().toISOString(),
        hostname: "board.example",
        action: "create_post",
      }),
      { status: 200 },
    );
  };

  try {
    assert.equal(
      await verifyTurnstile("test-token", "test-secret", {
        hostname: "board.example",
        action: "create_post",
      }),
      true,
    );
    assert.equal(requestBody?.get("secret"), "test-secret");
    assert.equal(requestBody?.get("response"), "test-token");
    assert.equal(requestBody?.has("remoteip"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects expired and unbound Turnstile challenges", async () => {
  const originalFetch = globalThis.fetch;
  const payloads = [
    {
      success: true,
      challenge_ts: new Date(Date.now() - 301_000).toISOString(),
      hostname: "board.example",
      action: "create_post",
    },
    {
      success: true,
      challenge_ts: new Date().toISOString(),
      hostname: "attacker.example",
      action: "create_post",
    },
    {
      success: true,
      challenge_ts: new Date().toISOString(),
      hostname: "board.example",
      action: "other_action",
    },
  ];
  globalThis.fetch = async () =>
    new Response(JSON.stringify(payloads.shift()), { status: 200 });

  try {
    const expected = { hostname: "board.example", action: "create_post" };
    assert.equal(await verifyTurnstile("token-1", "test-secret", expected), false);
    assert.equal(await verifyTurnstile("token-2", "test-secret", expected), false);
    assert.equal(await verifyTurnstile("token-3", "test-secret", expected), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails closed when the provider rejects the token", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: false }), { status: 200 });

  try {
    assert.equal(await verifyTurnstile("invalid-token", "test-secret"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails closed when Turnstile is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network error");
  };

  try {
    await assert.rejects(
      verifyTurnstile("test-token", "test-secret"),
      /CAPTCHA verification unavailable/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
