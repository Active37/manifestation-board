import { resolve } from "node:path";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { recordAuditLog } from "../audit.js";
import { loadDatabaseConfig } from "../config.js";
import { normalizeAdminEmail } from "./service.js";

const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine((password) => Buffer.byteLength(password, "utf8") <= 72);
const bootstrapSchema = z.object({
  ADMIN_BOOTSTRAP_EMAIL: z
    .string()
    .transform(normalizeAdminEmail)
    .pipe(z.string().email().max(320)),
  ADMIN_BOOTSTRAP_PASSWORD: passwordSchema,
});

export async function createInitialAdmin(
  pool: Pool,
  email: string,
  password: string,
): Promise<void> {
  const passwordHash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [51467102]);
    const existing = await client.query(
      "SELECT 1 FROM moderators WHERE role = 'admin' LIMIT 1",
    );
    if (existing.rowCount) {
      throw new Error("An admin account already exists");
    }

    const result = await client.query<{ id: string }>(
      `
        INSERT INTO moderators (email, password_hash, role)
        VALUES ($1, $2, 'admin')
        RETURNING id
      `,
      [email, passwordHash],
    );
    const moderator = result.rows[0];
    if (!moderator) {
      throw new Error("Initial admin insert returned no row");
    }
    await recordAuditLog(
      client,
      "system",
      null,
      "moderator_created",
      "moderator",
      moderator.id,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function run(): Promise<void> {
  const parsed = bootstrapSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => String(issue.path[0]))),
    ];
    throw new Error(`Invalid bootstrap environment variables: ${fields.join(", ")}`);
  }

  const config = loadDatabaseConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    await createInitialAdmin(
      pool,
      parsed.data.ADMIN_BOOTSTRAP_EMAIL,
      parsed.data.ADMIN_BOOTSTRAP_PASSWORD,
    );
  } finally {
    await pool.end();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(__filename);

if (isMain) {
  run()
    .then(() => {
      console.log("Initial admin account created");
    })
    .catch(() => {
      console.error(
        "Admin bootstrap failed; verify the database and required environment variables.",
      );
      process.exitCode = 1;
    });
}
