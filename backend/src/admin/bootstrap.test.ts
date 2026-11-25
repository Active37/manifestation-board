import assert from "node:assert/strict";
import type { Pool } from "pg";
import test from "node:test";
import { createInitialAdmin } from "./bootstrap.js";

test("records initial administrator creation in the same transaction", async () => {
  const moderatorId = "00000000-0000-4000-8000-000000000001";
  const queries: { sql: string; values?: unknown[] }[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes("SELECT 1 FROM moderators")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO moderators")) {
        return { rows: [{ id: moderatorId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;

  await createInitialAdmin(
    pool,
    "admin@example.com",
    "A-long-test-password-123",
  );

  assert.deepEqual(queries[0], { sql: "BEGIN", values: undefined });
  assert.deepEqual(queries.at(-2)?.values, [
    "system",
    null,
    "moderator_created",
    "moderator",
    moderatorId,
  ]);
  assert.equal(queries.at(-1)?.sql, "COMMIT");
  assert.equal(
    queries.some((query) => query.values?.includes("admin@example.com")),
    true,
  );
  assert.equal(
    queries.find((query) => query.sql.includes("INSERT INTO audit_logs"))?.values
      ?.includes("admin@example.com"),
    false,
  );
});
