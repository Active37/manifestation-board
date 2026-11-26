import bcrypt from "bcryptjs";
import { Pool } from "pg";

const email = process.env.ADMIN_BOOTSTRAP_EMAIL?.normalize("NFKC").trim().toLowerCase();
const password = process.env.ADMIN_BOOTSTRAP_PASSWORD ?? "";
const connectionString = process.env.DATABASE_URL;

if (!email || !password || !connectionString) {
  throw new Error("DATABASE_URL, ADMIN_BOOTSTRAP_EMAIL, and ADMIN_BOOTSTRAP_PASSWORD are required");
}
if (Buffer.byteLength(password, "utf8") > 72 || password.length < 12) {
  throw new Error("Admin password must be 12-72 UTF-8 bytes and at least 12 characters");
}

const pool = new Pool({ connectionString, max: 1 });

async function bootstrapAdmin(): Promise<void> {
  const existing = await pool.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM moderators WHERE role = 'admin' AND active = true) AS exists",
  );
  if (existing.rows[0]?.exists) {
    throw new Error("An active admin already exists");
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(
    "INSERT INTO moderators (email, password_hash, role) VALUES ($1, $2, 'admin')",
    [email, passwordHash],
  );
  console.log("Initial admin created");
}

bootstrapAdmin()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Admin bootstrap failed");
    process.exitCode = 1;
  })
  .finally(() => pool.end());