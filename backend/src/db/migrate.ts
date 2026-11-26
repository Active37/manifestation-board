import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";

const migrationLockId = 51467101;
const migrationFilePattern = /^\d+_[\w-]+\.sql$/;

async function runMigrations(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString, max: 1 });
  const migrationDirectory = join(process.cwd(), "backend", "migrations");
  let migrationClient: PoolClient | undefined;
  let lockAcquired = false;

  try {
    const client = await pool.connect();
    migrationClient = client;
    await client.query("SELECT pg_advisory_lock($1)", [migrationLockId]);
    lockAcquired = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationDirectory))
      .filter((file) => migrationFilePattern.test(file))
      .sort();

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

        const sql = await readFile(join(migrationDirectory, file), "utf8");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        console.log(`Applied migration ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      if (migrationClient && lockAcquired) {
        await migrationClient.query("SELECT pg_advisory_unlock($1)", [migrationLockId]);
      }
    } finally {
      migrationClient?.release();
      await pool.end();
    }
  }
}

runMigrations().catch((error: unknown) => {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : null;
  console.error(code ? `Migration failed (${code})` : "Migration failed");
  process.exitCode = 1;
});