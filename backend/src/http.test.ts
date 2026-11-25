import assert from "node:assert/strict";
import express from "express";
import test from "node:test";
import { createApiServer } from "./http.js";

test("sets conservative HTTP parser and socket timeouts", () => {
  const server = createApiServer(express(), { requestTimeoutMs: 30_000 });

  assert.equal(server.requestTimeout, 30_000);
  assert.equal(server.headersTimeout, 10_000);
  assert.equal(server.timeout, 31_000);
  assert.equal(server.keepAliveTimeout, 5_000);
  assert.equal(server.maxHeadersCount, 100);
});
