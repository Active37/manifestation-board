import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { loadMigrationDatabaseConfig } from "../config.js";
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

async function runMigrations(): Promise<void> {
  const config = loadMigrationDatabaseConfig();
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 120_000,
    query_timeout: 130_000,
  });
  const migrationDir = join(process.cwd(), "backend", "migrations");

  try {
    const files = (await readdir(migrationDir))
      .filter((file) => /^\d+_[\w-]+\.sql$/.test(file))
      .sort();
    const client = await pool.connect();
    try {
      await withMigrationLock(client, async () => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            name text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
          )
        `);

        for (const file of files) {
          await client.query("BEGIN");
          try {
            const applied = await client.query(
              "SELECT 1 FROM schema_migrations WHERE name = $1",
              [file],
            );
            if (applied.rowCount) {
              await client.query("COMMIT");
              continue;
            }

            const sql = await readFile(join(migrationDir, file), "utf8");
            await client.query(sql);
            await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
            await client.query("COMMIT");
            console.log(`Applied migration ${file}`);
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
      });
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

runMigrations().catch((error: unknown) => {
  const code = safeErrorCode(error);
  console.error(code ? `Migration failed (${code})` : "Migration failed");
  process.exitCode = 1;
});
