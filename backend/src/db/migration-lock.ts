import type { PoolClient } from "pg";

const migrationLockId = 1_475_938_201;

export async function withMigrationLock<T>(
  client: PoolClient,
  migrate: () => Promise<T>,
): Promise<T> {
  await client.query("SELECT set_config('lock_timeout', $1, false)", [
    "30s",
  ]);
  await client.query("SELECT pg_advisory_lock($1)", [migrationLockId]);
  try {
    return await migrate();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [migrationLockId]);
  }
}
