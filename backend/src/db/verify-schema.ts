import { Pool } from "pg";

type ExpectedColumn = {
  name: string;
  dataType: string;
  nullable: "YES" | "NO";
};

const required = (name: string, dataType: string): ExpectedColumn => ({
  name,
  dataType,
  nullable: "NO",
});

const optional = (name: string, dataType: string): ExpectedColumn => ({
  name,
  dataType,
  nullable: "YES",
});

const expectedColumns: Record<string, ExpectedColumn[]> = {
  semesters: [
    required("id", "uuid"),
    required("name", "text"),
    required("ends_on", "date"),
    required("state", "text"),
  ],
  posts: [
    required("id", "uuid"),
    required("display_name", "text"),
    required("name_key", "text"),
    required("body", "text"),
    optional("category", "text"),
    required("status", "text"),
    required("edit_key_hash", "text"),
    required("like_count", "integer"),
    required("report_count", "integer"),
    required("semester_id", "uuid"),
    required("created_at", "timestamp with time zone"),
    required("updated_at", "timestamp with time zone"),
    optional("rejected_at", "timestamp with time zone"),
  ],
  likes: [
    required("post_id", "uuid"),
    required("device_id", "text"),
    required("created_at", "timestamp with time zone"),
  ],
  reports: [
    required("post_id", "uuid"),
    required("device_id", "text"),
    required("reason", "text"),
    optional("detail", "text"),
    required("created_at", "timestamp with time zone"),
  ],
  moderators: [
    required("id", "uuid"),
    required("email", "text"),
    required("password_hash", "text"),
    required("role", "text"),
    required("active", "boolean"),
  ],
  banned_terms: [required("term", "text"), required("type", "text")],
  post_rate_limits: [
    required("action_type", "text"),
    required("subject_type", "text"),
    required("subject_hash", "text"),
    required("window_started_at", "timestamp with time zone"),
    required("request_count", "integer"),
  ],
  admin_sessions: [
    required("token_hash", "text"),
    required("csrf_hash", "text"),
    required("moderator_id", "uuid"),
    required("expires_at", "timestamp with time zone"),
    required("created_at", "timestamp with time zone"),
  ],
  moderation_actions: [
    required("id", "bigint"),
    required("post_id", "uuid"),
    optional("moderator_id", "uuid"),
    required("action", "text"),
    required("from_status", "text"),
    required("to_status", "text"),
    optional("from_rejected_at", "timestamp with time zone"),
    optional("to_rejected_at", "timestamp with time zone"),
    required("created_at", "timestamp with time zone"),
    optional("undone_at", "timestamp with time zone"),
    optional("undone_by", "uuid"),
  ],
};

const requiredConstraints = [
  "semesters_pkey",
  "semesters_state_check",
  "moderators_pkey",
  "moderators_email_uq",
  "moderators_role_check",
  "banned_terms_pkey",
  "posts_pkey",
  "posts_name_key_uq",
  "posts_name_key_normalized_check",
  "posts_body_length_check",
  "posts_category_check",
  "posts_status_check",
  "posts_edit_key_hash_check",
  "posts_like_count_check",
  "posts_report_count_check",
  "posts_semester_id_fkey",
  "posts_rejected_at_check",
  "likes_pkey",
  "likes_post_id_fkey",
  "reports_pkey",
  "reports_post_id_fkey",
  "reports_reason_check",
  "post_rate_limits_pkey",
  "post_rate_limits_action_type_check",
  "post_rate_limits_subject_type_check",
  "post_rate_limits_subject_hash_check",
  "post_rate_limits_request_count_check",
  "admin_sessions_pkey",
  "admin_sessions_token_hash_check",
  "admin_sessions_csrf_hash_check",
  "admin_sessions_moderator_id_fkey",
  "moderation_actions_pkey",
  "moderation_actions_post_id_fkey",
  "moderation_actions_moderator_id_fkey",
  "moderation_actions_action_check",
  "moderation_actions_from_status_check",
  "moderation_actions_to_status_check",
  "moderation_actions_undo_pair_check",
  "moderation_actions_undone_by_fkey",
];

const requiredIndexes = [
  "semesters_one_open_idx",
  "posts_live_created_at_idx",
  "posts_live_like_count_idx",
  "posts_status_created_at_idx",
  "likes_created_at_post_id_idx",
  "post_rate_limits_window_started_at_idx",
  "admin_sessions_expires_at_idx",
  "moderation_actions_undo_idx",
  "moderation_actions_created_at_idx",
];

function sorted(values: string[]): string[] {
  return [...values].sort();
}

async function verifySchema(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const tables = await pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name <> 'schema_migrations'
    `);
    const actualTables = sorted(tables.rows.map((row) => row.table_name));
    const expectedTableNames = sorted(Object.keys(expectedColumns));
    if (JSON.stringify(actualTables) !== JSON.stringify(expectedTableNames)) {
      throw new Error(
        `Unexpected v1 tables: ${actualTables.join(", ") || "none"}`,
      );
    }

    const columns = await pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: "YES" | "NO";
    }>(`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position
    `, [expectedTableNames]);
    const actualColumns = new Map<string, ExpectedColumn[]>();
    for (const row of columns.rows) {
      const current = actualColumns.get(row.table_name) ?? [];
      current.push({
        name: row.column_name,
        dataType: row.data_type,
        nullable: row.is_nullable,
      });
      actualColumns.set(row.table_name, current);
    }
    for (const [table, expected] of Object.entries(expectedColumns)) {
      const actual = actualColumns.get(table) ?? [];
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Unexpected columns or types for ${table}`);
      }
    }

    const constraints = await pool.query<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace
    `);
    const actualConstraints = new Set(
      constraints.rows.map((row) => row.conname),
    );
    const missingConstraints = requiredConstraints.filter(
      (name) => !actualConstraints.has(name),
    );
    if (missingConstraints.length) {
      throw new Error(`Missing constraints: ${missingConstraints.join(", ")}`);
    }

    const indexes = await pool.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
    `);
    const actualIndexes = new Set(indexes.rows.map((row) => row.indexname));
    const missingIndexes = requiredIndexes.filter(
      (name) => !actualIndexes.has(name),
    );
    if (missingIndexes.length) {
      throw new Error(`Missing indexes: ${missingIndexes.join(", ")}`);
    }

    const applied = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE name = '001_initial_schema.sql'",
    );
    if (!applied.rowCount) {
      throw new Error("Initial schema migration is not recorded as applied");
    }

    console.log("PostgreSQL schema matches the PRD v1 database model.");
  } finally {
    await pool.end();
  }
}

verifySchema().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Schema verification failed");
  process.exitCode = 1;
});