import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import test from "node:test";
import { withMigrationLock } from "./migration-lock.js";

test("holds the migration lock through work and releases it on success", async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;

  assert.equal(
    await withMigrationLock(client, async () => {
      calls.push("migration");
      return "complete";
    }),
    "complete",
  );
  assert.deepEqual(calls, [
    "SELECT set_config('lock_timeout', $1, false)",
    "SELECT pg_advisory_lock($1)",
    "migration",
    "SELECT pg_advisory_unlock($1)",
  ]);
});

test("releases the migration lock when a migration fails", async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;

  await assert.rejects(
    withMigrationLock(client, async () => {
      throw new Error("migration failed");
    }),
    /migration failed/,
  );
  assert.deepEqual(calls, [
    "SELECT set_config('lock_timeout', $1, false)",
    "SELECT pg_advisory_lock($1)",
    "SELECT pg_advisory_unlock($1)",
  ]);
});
