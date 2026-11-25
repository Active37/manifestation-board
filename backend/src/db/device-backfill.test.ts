import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import test from "node:test";
import { hashIdentifier } from "../identifiers.js";
import { backfillInteractionDeviceIds } from "./device-backfill.js";

test("backfills legacy interaction identifiers in batches without storing raw values", async () => {
  const secret = "a-random-secret-with-at-least-32-characters";
  const rows = new Map([
    ["likes", [{ row_id: "(0,1)", device_id: "legacy-like-device" }]],
    ["reports", [{ row_id: "(0,2)", device_id: "legacy-report-device" }]],
  ]);
  const updates: { table: string; values: unknown[] }[] = [];
  const validations: string[] = [];
  const reads = new Map<string, number>();
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("FROM likes") || sql.includes("FROM reports")) {
        const table = sql.includes("FROM likes") ? "likes" : "reports";
        const readCount = reads.get(table) ?? 0;
        reads.set(table, readCount + 1);
        return {
          rows: readCount === 0 ? rows.get(table) : [],
          rowCount: readCount === 0 ? 1 : 0,
        };
      }
      if (sql.includes("UPDATE likes AS target")) {
        updates.push({ table: "likes", values: values ?? [] });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE reports AS target")) {
        updates.push({ table: "reports", values: values ?? [] });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("VALIDATE CONSTRAINT")) {
        validations.push(sql);
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;

  assert.equal(await backfillInteractionDeviceIds(client, secret), 2);
  assert.deepEqual(
    updates.map(({ table, values }) => [
      table,
      values[0],
      values[1],
    ]),
    [
      ["likes", ["(0,1)"], [hashIdentifier(secret, "device", "legacy-like-device")]],
      ["reports", ["(0,2)"], [hashIdentifier(secret, "device", "legacy-report-device")]],
    ],
  );
  assert.equal(validations.length, 4);
});
