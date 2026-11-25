import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import type { PoolClient } from "pg";
import test from "node:test";
import { recordAuditLog } from "./audit.js";
import {
  requestIdMiddleware,
  setDatabaseRequestId,
} from "./request-context.js";

test("correlates audit writes with a server-generated request ID", async () => {
  const queries: { sql: string; values?: unknown[] }[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  const app = express();
  app.use(requestIdMiddleware);
  app.post("/", async (_req, res) => {
    await client.query("BEGIN");
    await setDatabaseRequestId(client);
    await recordAuditLog(client, "system", null, "admin_login_failed", "auth", null, {
      outcome: "failure",
      metadata: { reason: "invalid_credentials" },
    });
    await client.query("COMMIT");
    res.status(204).end();
  });
  const server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Test server did not start");
  }

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: "POST",
      headers: { "X-Request-Id": "client-controlled" },
    });
    const requestId = response.headers.get("x-request-id");

    assert.equal(response.status, 204);
    assert.match(requestId ?? "", /^[0-9a-f-]{36}$/i);
    assert.notEqual(requestId, "client-controlled");
    assert.deepEqual(queries[1]?.values, [requestId]);
    assert.match(queries[2]?.sql ?? "", /current_setting\('app\.request_id', true\)/);
    assert.deepEqual(queries[2]?.values, [
      "system",
      null,
      "admin_login_failed",
      "auth",
      null,
      "failure",
      { reason: "invalid_credentials" },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
