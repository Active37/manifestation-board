import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { RequestHandler } from "express";

const requestIds = new AsyncLocalStorage<string>();

export const requestIdMiddleware: RequestHandler = (_req, res, next) => {
  const requestId = randomUUID();
  res.setHeader("X-Request-Id", requestId);
  requestIds.run(requestId, () => next());
};

export async function setDatabaseRequestId(client: PoolClient): Promise<void> {
  const requestId = requestIds.getStore();
  if (requestId) {
    await client.query("SELECT set_config('app.request_id', $1, true)", [
      requestId,
    ]);
  }
}
