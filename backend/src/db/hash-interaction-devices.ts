import { Pool } from "pg";
import { loadMigrationDatabaseConfig } from "../config.js";
import { backfillInteractionDeviceIds } from "./device-backfill.js";
import { withMigrationLock } from "./migration-lock.js";

function safeErrorCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,16}$/.test(error.code)
  ) {
    return error.code;
  }
  return null;
}

async function hashInteractionDevices(): Promise<void> {
  const secret = process.env.IP_HASH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("Invalid environment variables: IP_HASH_SECRET");
  }
  const config = loadMigrationDatabaseConfig();
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 120_000,
    query_timeout: 130_000,
  });

  try {
    const client = await pool.connect();
    try {
      const count = await withMigrationLock(client, () =>
        backfillInteractionDeviceIds(client, secret),
      );
      console.log(`Hashed ${count} interaction device identifiers`);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

hashInteractionDevices().catch((error: unknown) => {
  const code = safeErrorCode(error);
  console.error(code ? `Device ID migration failed (${code})` : "Device ID migration failed");
  process.exitCode = 1;
});
