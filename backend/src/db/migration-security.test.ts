import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("adds abuse-control storage and database constraints", async () => {
  const migration = await readFile(
    "backend/migrations/014_abuse_controls.sql",
    "utf8",
  );

  for (const constraint of [
    "post_rate_limits_action_type_check",
    "posts_edit_key_hash_check",
    "posts_display_name_length_check",
    "posts_rejected_at_check",
    "posts_category_fkey",
    "reports_detail_length_check",
    "admin_sessions_token_hash_check",
    "admin_sessions_csrf_hash_check",
    "admin_sessions_expiry_check",
    "moderators_password_hash_check",
  ]) {
    assert.ok(migration.includes(constraint), `missing ${constraint}`);
  }
  assert.match(migration, /CREATE TABLE used_captcha_tokens[\s\S]*token_hash char\(64\) PRIMARY KEY/);
  assert.match(migration, /ADD COLUMN blocked_until timestamptz/);
  assert.match(migration, /ADD COLUMN violation_count integer NOT NULL DEFAULT 0/);
  assert.doesNotMatch(migration, /\b(DROP TABLE|TRUNCATE)\b/i);
});

test("extends the append-only audit log with correlation and safe outcomes", async () => {
  const migration = await readFile(
    "backend/migrations/015_security_audit.sql",
    "utf8",
  );

  assert.match(migration, /ADD COLUMN request_id uuid/);
  assert.match(migration, /outcome IN \('success', 'failure'\)/);
  assert.match(migration, /metadata jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(migration, /'admin_login_succeeded'/);
  assert.match(migration, /'admin_login_failed'/);
  assert.match(migration, /'admin_logout'/);
  assert.match(migration, /'authorization_denied'/);
  assert.match(migration, /'rate_limit_exceeded'/);
  assert.match(migration, /CREATE INDEX audit_logs_request_id_idx/);
  assert.doesNotMatch(migration, /\b(DROP TABLE|TRUNCATE)\b/i);
});

test("indexes login-attempt retention data without dropping records", async () => {
  const migration = await readFile(
    "backend/migrations/016_auth_cleanup_index.sql",
    "utf8",
  );
  assert.match(migration, /CREATE INDEX admin_login_attempts_window_idx/);
  assert.doesNotMatch(migration, /\b(DROP TABLE|DELETE FROM|TRUNCATE)\b/i);
});

test("requires hashed interaction identifiers without deleting legacy rows", async () => {
  const migration = await readFile(
    "backend/migrations/017_interaction_device_hashes.sql",
    "utf8",
  );
  for (const constraint of [
    "likes_device_id_hash_required_check",
    "likes_device_id_hash_format_check",
    "reports_device_id_hash_required_check",
    "reports_device_id_hash_format_check",
  ]) {
    assert.ok(migration.includes(constraint), `missing ${constraint}`);
  }
  assert.equal((migration.match(/NOT VALID/g) ?? []).length, 4);
  assert.equal((migration.match(/device_id_hash_version = 1/g) ?? []).length, 2);
  assert.doesNotMatch(migration, /\b(DROP TABLE|DELETE FROM|TRUNCATE)\b/i);
});
